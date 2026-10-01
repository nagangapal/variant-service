/**
 * In-process experiment config cache.
 *
 * This is the component that decides whether a database problem becomes a customer
 * problem. Three rules drive the whole design:
 *
 *   1. NEVER let a config refresh failure turn into a failed assignment. Once we have a
 *      good snapshot we keep serving it indefinitely, and we surface its age as a metric
 *      rather than as an outage. Serving a split that is 30 seconds out of date is
 *      harmless; 500ing a checkout page is not.
 *
 *   2. Never stampede. A cold start with 2,000 concurrent requests must issue one query,
 *      not 2,000. Every concurrent caller awaits the same in-flight promise.
 *
 *   3. Propagate writes by push, not by polling. The control plane issues a Postgres
 *      NOTIFY and every instance refreshes immediately. A short TTL remains only as a
 *      backstop, so a missed notification self-heals.
 *
 * The only case that returns "no assignment" is a cold start that has never reached the
 * database, which correctly degrades to the customer's default experience.
 */

import pg from 'pg';
import { compileExperiment } from '../core/bucketing.js';
import type { CompiledExperiment, Experiment } from '../core/types.js';
import { getEnv } from '../config/env.js';
import { query } from '../db/pool.js';

const CHANNEL = 'config_changed';

/**
 * A never-empty description of a thrown value.
 *
 * `err.message` is not guaranteed to be truthy -- node-postgres produces connection
 * errors with an empty message -- and an empty string used as a health signal is worse
 * than no signal, because it reads as "no problem" to everything downstream.
 */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message?.trim();
    if (msg) return msg;
    return err.name || err.constructor?.name || 'unknown error';
  }
  const text = String(err ?? '').trim();
  return text || 'unknown error';
}

export interface CacheHealth {
  status: 'cold' | 'warm' | 'stale' | 'expired';
  experimentCount: number;
  ageMs: number;
  maxStaleMs: number;
  lastError: string | null;
  lastRefreshAt: number | null;
  refreshCount: number;
  refreshFailureCount: number;
  singleFlightJoins: number;
  notificationCount: number;
}

interface Snapshot {
  experiments: Map<string, CompiledExperiment>;
  loadedAt: number;
}

export function cacheKey(namespace: string, id: string): string {
  return `${namespace}/${id}`;
}

/**
 * Postgres returns timestamps as Date objects for plain columns, but as ISO *strings*
 * once they have been through json_agg, because JSON has no date type. This normalises
 * both so a change of query shape cannot turn into a runtime TypeError inside the
 * config loader.
 */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return new Date(String(value)).toISOString();
}

export class ConfigCache {
  private snapshot: Snapshot | null = null;
  private inflight: Promise<void> | null = null;
  private listener: pg.Client | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  private lastError: string | null = null;
  /**
   * Whether the most recent refresh attempt failed.
   *
   * Deliberately separate from `lastError`. An earlier version derived staleness from
   * `lastError` being truthy, which silently failed: node-postgres surfaces some
   * connection failures as an Error with an empty message, so `lastError` was `''`,
   * which is falsy, so a cache being served stale after a database outage reported
   * status 'warm' and the assign endpoint reported stale:false. The fail-safe
   * behaviour was still correct -- it kept serving -- but nothing signalled the
   * outage, which is the part that matters when you are trying to notice one.
   */
  private lastRefreshFailed = false;
  private lastRefreshAt: number | null = null;
  private refreshCount = 0;
  private refreshFailureCount = 0;
  private singleFlightJoins = 0;
  private notificationCount = 0;

  private readonly ttlMs: number;
  private readonly maxStaleMs: number;

  constructor(opts?: { ttlMs?: number; maxStaleMs?: number }) {
    const env = getEnv();
    this.ttlMs = opts?.ttlMs ?? env.CONFIG_TTL_MS;
    this.maxStaleMs = opts?.maxStaleMs ?? env.CONFIG_MAX_STALE_MS;
  }

  /**
   * Look up a compiled experiment. Loads the config on first use, then serves from memory.
   *
   * Never rejects: any failure resolves to `undefined`, which the caller turns into a
   * no-assignment response.
   */
  async get(namespace: string, id: string): Promise<CompiledExperiment | undefined> {
    // Read the snapshot into a local. refresh() may repopulate this.snapshot, which
    // TypeScript's control-flow analysis cannot see across the await.
    const snap = this.snapshot;
    if (snap && Date.now() - snap.loadedAt < this.ttlMs) {
      return snap.experiments.get(cacheKey(namespace, id));
    }
    if (snap) {
      // Stale but usable. Kick off a refresh without blocking this request: the caller
      // gets the slightly old value immediately, which is the entire point.
      void this.refresh();
      return snap.experiments.get(cacheKey(namespace, id));
    }
    // Cold. We must block, otherwise we cannot answer. Bounded by a single refresh
    // that all concurrent callers share.
    await this.refresh();
    const fresh = this.snapshot;
    return fresh ? fresh.experiments.get(cacheKey(namespace, id)) : undefined;
  }

  /** Fetch all experiments, with every caller sharing one in-flight request. */
  async refresh(): Promise<void> {
    if (this.inflight) {
      this.singleFlightJoins++;
      return this.inflight;
    }

    this.inflight = (async () => {
      try {
        const rows = await this.loadExperiments();
        const next = new Map<string, CompiledExperiment>();
        for (const exp of rows) {
          next.set(cacheKey(exp.namespace, exp.id), compileExperiment(exp));
        }
        // Swap the whole map at once. Readers either see the old snapshot or the new
        // one, never a partially rebuilt structure.
        this.snapshot = { experiments: next, loadedAt: Date.now() };
        this.lastError = null;
        this.lastRefreshFailed = false;
        this.lastRefreshAt = Date.now();
        this.refreshCount++;
      } catch (err) {
        this.lastError = describeError(err);
        this.lastRefreshFailed = true;
        this.refreshFailureCount++;
        // Intentionally no rethrow and no snapshot mutation. A failed refresh is a
        // no-op; the previous snapshot remains authoritative.
      } finally {
        this.inflight = null;
      }
    })();

    return this.inflight;
  }

  private async loadExperiments(): Promise<Experiment[]> {
    const { rows } = await query<{
      namespace: string;
      id: string;
      status: Experiment['status'];
      allocation_bps: number;
      salt: string | null;
      version: string;
      created_at: Date;
      updated_at: Date;
      variants: { key: string; weightBps: number }[] | null;
      creatives: {
        variantKey: string;
        id: string;
        source: 'static' | 'llm';
        headline: string;
        cta: string | null;
        body: string | null;
        model: string | null;
        createdAt: Date;
      }[] | null;
    }>(
      `SELECT e.namespace,
              e.id,
              e.status,
              e.allocation_bps,
              e.salt,
              e.version,
              e.created_at,
              e.updated_at,
              COALESCE(
                (SELECT json_agg(json_build_object('key', v.key, 'weightBps', v.weight_bps)
                                ORDER BY v.key)
                   FROM variants v
                  WHERE v.namespace = e.namespace AND v.experiment_id = e.id),
                '[]'
              ) AS variants,
              COALESCE(
                (SELECT json_agg(json_build_object(
                          'variantKey', c.variant_key,
                          'id', c.id,
                          'source', c.source,
                          'headline', c.headline,
                          'cta', c.cta,
                          'body', c.body,
                          'model', c.model,
                          'createdAt', c.created_at)
                          ORDER BY c.variant_key)
                   FROM creatives c
                  WHERE c.namespace = e.namespace AND c.experiment_id = e.id AND c.pinned),
                '[]'
              ) AS creatives
         FROM experiments e
        WHERE e.status IN ('running','paused','draft')`,
    );

    return rows.map((r) => {
      const creatives: Experiment['creatives'] = {};
      for (const c of r.creatives ?? []) {
        creatives[c.variantKey] = {
          id: c.id,
          source: c.source,
          headline: c.headline,
          cta: c.cta ?? undefined,
          body: c.body ?? undefined,
          model: c.model,
          createdAt: toIso(c.createdAt),
        };
      }
      return {
        namespace: r.namespace,
        id: r.id,
        status: r.status,
        allocationBps: r.allocation_bps,
        salt: r.salt,
        variants: (r.variants ?? []) as unknown as Experiment['variants'],        creatives,
        version: Number(r.version),
        createdAt: toIso(r.created_at),
        updatedAt: toIso(r.updated_at),
      };
    });
  }

  /**
   * Push invalidation. Control-plane writes call this on the writing instance, and the
   * NOTIFY reaches every other instance so they refresh within milliseconds rather than
   * waiting out the TTL.
   */
  async notifyChanged(namespace: string): Promise<void> {
    try {
      await query('SELECT pg_notify($1, $2)', [CHANNEL, namespace]);
    } catch (err) {
      // Invalidation is an optimisation. If it fails the TTL still self-heals, so this
      // must not fail the caller's write.
      this.lastError = `notify failed: ${describeError(err)}`;
    }
  }

  /**
   * Start background refresh and the NOTIFY listener.
   *
   * The timer keeps the cache warm even during zero traffic, which matters because a
   * cold cache makes the first request of a quiet period pay the database latency.
   */
  async start(): Promise<void> {
    this.stopped = false;

    // Warm eagerly. Failure here is non-fatal: the first request will retry.
    await this.refresh();

    this.timer = setInterval(() => {
      if (!this.stopped) void this.refresh();
    }, Math.max(1000, Math.floor(this.ttlMs / 2)));
    this.timer.unref();

    await this.startListener();
  }

  private async startListener(): Promise<void> {
    const env = getEnv();
    const client = new pg.Client({
      // Must be a session, so this cannot go through a transaction-mode pooler
      // (PgBouncer). Prefer the direct endpoint when one is configured.
      connectionString: env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL,
      connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
    });

    client.on('notification', () => {
      this.notificationCount++;
      void this.refresh();
    });

    client.on('error', (err) => {
      this.lastError = `listener error: ${describeError(err)}`;
      this.listener = null;
      // Reconnect with backoff. A dead listener degrades us to TTL-based refresh,
      // which is slower but still correct.
      if (!this.stopped) {
        setTimeout(() => {
          void this.startListener();
        }, 2000).unref();
      }
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.listener = client;
    } catch {
      this.listener = null;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.listener) {
      try {
        await this.listener.end();
      } catch {
        // Already dead.
      }
      this.listener = null;
    }
  }

  /** Ids of every running experiment in a namespace, from the current snapshot. */
  listRunning(namespace: string): string[] {
    if (!this.snapshot) return [];
    const out: string[] = [];
    for (const exp of this.snapshot.experiments.values()) {
      if (exp.namespace === namespace && exp.status === 'running') out.push(exp.id);
    }
    return out;
  }

  health(): CacheHealth {
    if (!this.snapshot) {
      return {
        status: 'cold',
        experimentCount: 0,
        ageMs: 0,
        maxStaleMs: this.maxStaleMs,
        lastError: this.lastError,
        lastRefreshAt: this.lastRefreshAt,
        refreshCount: this.refreshCount,
        refreshFailureCount: this.refreshFailureCount,
        singleFlightJoins: this.singleFlightJoins,
        notificationCount: this.notificationCount,
      };
    }
    const ageMs = Date.now() - this.snapshot.loadedAt;
    return {
      // 'stale' is driven by the explicit failure flag, not by lastError's truthiness.
      status: ageMs > this.maxStaleMs ? 'expired' : this.lastRefreshFailed ? 'stale' : 'warm',
      experimentCount: this.snapshot.experiments.size,
      ageMs,
      maxStaleMs: this.maxStaleMs,
      lastError: this.lastError,
      lastRefreshAt: this.lastRefreshAt,
      refreshCount: this.refreshCount,
      refreshFailureCount: this.refreshFailureCount,
      singleFlightJoins: this.singleFlightJoins,
      notificationCount: this.notificationCount,
    };
  }

  /** Test seam: inject a snapshot without a database. */
  setSnapshotForTest(exps: Experiment[]): void {
    const m = new Map<string, CompiledExperiment>();
    for (const e of exps) m.set(cacheKey(e.namespace, e.id), compileExperiment(e));
    this.snapshot = { experiments: m, loadedAt: Date.now() };
  }
}
