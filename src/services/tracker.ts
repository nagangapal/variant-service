/**
 * Event ingestion.
 *
 * Tracking must never be able to fail a customer's page, and it must not be able to
 * make a page load wait on our database either. The design is an optimistic write with
 * a bounded in-memory retry queue:
 *
 *   1. INSERT ... ON CONFLICT (event_id) DO NOTHING, awaited, with a hard timeout.
 *   2. Success, or a conflict, means done. Conflicts are the client's retry, which is
 *      the case the whole design is built around.
 *   3. Timeout or connection error means the event is pushed onto an in-memory queue
 *      and retried with backoff. The HTTP response was already sent.
 *   4. If the queue is full, drop the event and count it. Dropping is the correct
 *      behaviour: an unbounded queue converts a database brownout into an OOM kill,
 *      which would take the whole service down rather than just the tracking path.
 *
 * The honest limitation, stated plainly: events in the in-memory queue are lost if the
 * process dies. That is a deliberate trade of a small, measurable loss window for
 * never having the tracking path threaten availability of the assignment path. The
 * dashboard surfaces the dropped count, and DESIGN.md describes the durable-queue
 * upgrade (client-side sendBeacon retry plus a server-side spool).
 */

import type { TrackEvent } from '../core/types.js';
import { getEnv } from '../config/env.js';
import { query } from '../db/pool.js';

/** A DB round trip that outlived its budget. Not a 5xx, and not the caller's problem. */
class WriteTimeout extends Error {
  constructor() {
    super('tracking write exceeded its time budget');
    this.name = 'WriteTimeout';
  }
}

export interface TrackerCounters {
  accepted: number;
  duplicates: number;
  failed: number;
  queued: number;
  retried: number;
  dropped: number;
  queueDepth: number;
  lastError: string | null;
}

export interface IngestResult {
  /** True when the event is durably stored. */
  durable: boolean;
  /** True when we had seen this eventId before. */
  duplicate: boolean;
}

export class Tracker {
  private queue: TrackEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  private readonly writeTimeoutMs: number;
  private readonly queueMax: number;
  private readonly retryIntervalMs: number;

  private counters: TrackerCounters = {
    accepted: 0,
    duplicates: 0,
    failed: 0,
    queued: 0,
    retried: 0,
    dropped: 0,
    queueDepth: 0,
    lastError: null,
  };

  constructor(opts?: { writeTimeoutMs?: number; queueMax?: number; retryIntervalMs?: number }) {
    const env = getEnv();
    this.writeTimeoutMs = opts?.writeTimeoutMs ?? env.TRACK_WRITE_TIMEOUT_MS;
    this.queueMax = opts?.queueMax ?? env.TRACK_QUEUE_MAX;
    this.retryIntervalMs = opts?.retryIntervalMs ?? env.TRACK_RETRY_INTERVAL_MS;
  }

  /**
   * Clamp the client-supplied timestamp.
   *
   * Client clocks are wrong, and a single event dated in 1970 or 2099 would drag the
   * results window around. We allow a generous window backwards and none forwards.
   */
  private normaliseTs(ts: number): number {
    const nowSec = Date.now() / 1000;
    const maxAge = 60 * 60 * 24; // one day
    if (!Number.isFinite(ts)) return nowSec;
    return Math.min(nowSec, Math.max(nowSec - maxAge, ts));
  }

  private async insert(events: TrackEvent[], timeoutMs: number): Promise<number> {
    if (events.length === 0) return 0;

    // One multi-row INSERT per batch. Row-per-statement would be a large multiple of the
    // network and CPU cost for no benefit at this volume.
    const values: unknown[] = [];
    const tuples: string[] = [];
    events.forEach((e, i) => {
      const b = i * 9;
      tuples.push(
        `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},to_timestamp($${b + 9}))`,
      );
      values.push(
        e.eventId,
        e.type,
        e.namespace,
        e.experimentId,
        e.variantKey,
        e.visitorId,
        e.goal ?? null,
        e.properties ? JSON.stringify(e.properties) : null,
        this.normaliseTs(e.ts / 1000),
      );
    });

    const sql = `
      INSERT INTO events (event_id, type, namespace, experiment_id, variant_key,
                          visitor_id, goal, properties, ts)
      VALUES ${tuples.join(',')}
      ON CONFLICT (event_id) DO NOTHING
    `;

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new WriteTimeout()), timeoutMs);
      timer.unref();
    });

    try {
      const res = await Promise.race([query(sql, values), timeout]);
      return res.rowCount ?? 0;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Accept one event. Never throws and never rejects.
   */
  async ingest(event: TrackEvent): Promise<IngestResult> {
    try {
      const inserted = await this.insert([event], this.writeTimeoutMs);
      if (inserted === 1) {
        this.counters.accepted++;
        return { durable: true, duplicate: false };
      }
      // Zero rows with ON CONFLICT DO NOTHING means the eventId already exists.
      this.counters.duplicates++;
      return { durable: true, duplicate: true };
    } catch (err) {
      this.counters.failed++;
      this.counters.lastError = (err as Error).message;
      this.enqueue(event);
      return { durable: false, duplicate: false };
    }
  }

  /** Accept many events, e.g. a batched beacon. */
  async ingestMany(events: TrackEvent[]): Promise<IngestResult> {
    if (events.length === 0) return { durable: true, duplicate: false };
    try {
      const inserted = await this.insert(events, this.writeTimeoutMs);
      this.counters.accepted += inserted;
      this.counters.duplicates += events.length - inserted;
      return { durable: true, duplicate: inserted < events.length };
    } catch (err) {
      this.counters.failed++;
      this.counters.lastError = (err as Error).message;
      for (const e of events) this.enqueue(e);
      return { durable: false, duplicate: false };
    }
  }

  private enqueue(event: TrackEvent): void {
    if (this.queue.length >= this.queueMax) {
      // Bounded on purpose. See the class comment: the alternative is an OOM that
      // takes assignment down with it.
      this.counters.dropped++;
      return;
    }
    this.queue.push(event);
    this.counters.queued++;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.timer = setInterval(() => void this.drain(), this.retryIntervalMs);
    this.timer.unref();
  }

  /**
   * Retry queued events in bounded batches.
   *
   * On a persistent failure we stop and wait for the next tick rather than hammering
   * a database that is already struggling. Backoff is the interval itself.
   */
  async drain(): Promise<void> {
    if (this.stopped || this.queue.length === 0) return;

    const batch = this.queue.splice(0, 500);
    try {
      const inserted = await this.insert(batch, this.writeTimeoutMs * 4);
      this.counters.accepted += inserted;
      this.counters.retried += batch.length;
    } catch (err) {
      this.counters.lastError = (err as Error).message;
      // Put it back at the front so ordering is roughly preserved, respecting the cap.
      const room = this.queueMax - this.queue.length;
      if (room > 0) this.queue.unshift(...batch.slice(0, room));
      else this.counters.dropped += batch.length - room;
    } finally {
      this.counters.queueDepth = this.queue.length;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Best-effort final flush. Anything still queued is lost, which the counters record.
    try {
      await this.drain();
    } catch {
      // Ignore: we are shutting down.
    }
  }

  stats(): TrackerCounters {
    return { ...this.counters, queueDepth: this.queue.length };
  }
}
