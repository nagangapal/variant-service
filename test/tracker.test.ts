/**
 * Tracker tests.
 *
 * The idempotency and failure behaviour is the part of this service most likely to
 * silently corrupt results, so it is tested against a real database where possible and
 * against a simulated one where we need the database to fail.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setEnv, type Env } from '../src/config/env.js';
import { Tracker } from '../src/services/tracker.js';
import { getPool, query, closePool } from '../src/db/pool.js';
import type { TrackEvent } from '../src/core/types.js';

const TEST_ENV: Env = {
  NODE_ENV: 'test',
  PORT: 0,
  HOST: '127.0.0.1',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://variant:variant@localhost:55432/variant',
  DB_POOL_MAX: 5,
  DB_STATEMENT_TIMEOUT_MS: 5000,
  DB_CONNECT_TIMEOUT_MS: 3000,
  CONFIG_TTL_MS: 1000,
  CONFIG_MAX_STALE_MS: 60000,
  ASSIGNMENT_DEADLINE_MS: 150,
  TRACK_WRITE_TIMEOUT_MS: 2000,
  TRACK_QUEUE_MAX: 1000,
  TRACK_RETRY_INTERVAL_MS: 200,
  ADMIN_TOKEN: 'test-token',
  LLM_PROVIDER: 'none',
  LLM_API_KEY: '',
  LLM_MODEL: '',
  LLM_BASE_URL: '',
  LLM_TIMEOUT_MS: 1000,
  LLM_MAX_CANDIDATES: 3,
  LOG_LEVEL: 'silent',
  PUBLIC_BASE_URL: '',
};

function event(overrides: Partial<TrackEvent> = {}): TrackEvent {
  return {
    eventId: randomUUID(),
    type: 'exposure',
    namespace: 'default',
    experimentId: 'test-exp',
    variantKey: 'control',
    visitorId: 'v1',
    ts: Date.now(),
    goal: null,
    properties: null,
    ...overrides,
  };
}

beforeAll(async () => {
  setEnv(TEST_ENV);
  await getPool().query('SELECT 1');
});

afterAll(async () => {
  await closePool();
});

describe('Tracker against a real database', () => {
  it('stores an event durably', async () => {
    const tracker = new Tracker();
    const e = event();
    const res = await tracker.ingest(e);
    expect(res).toEqual({ durable: true, duplicate: false });

    const { rows } = await query('SELECT type, variant_key, visitor_id FROM events WHERE event_id = $1', [e.eventId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'exposure', variant_key: 'control', visitor_id: 'v1' });
  });

  // This is the core duplicate-exposure defence: a client retrying its beacon must not
  // create a second row.
  it('treats a repeated eventId as a duplicate, not a second event', async () => {
    const tracker = new Tracker();
    const e = event();
    const first = await tracker.ingest(e);
    const second = await tracker.ingest(e);
    const third = await tracker.ingest(e);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(third.duplicate).toBe(true);

    const { rows } = await query('SELECT count(*)::int AS n FROM events WHERE event_id = $1', [e.eventId]);
    expect(rows[0]!.n).toBe(1);
  });

  it('reports partial dedupe in a batch', async () => {
    const tracker = new Tracker();
    const dup = event();
    await tracker.ingest(dup);
    const fresh = event();
    const res = await tracker.ingestMany([dup, fresh]);
    expect(res.durable).toBe(true);
    expect(res.duplicate).toBe(true);

    const { rows } = await query('SELECT count(*)::int AS n FROM events WHERE event_id = $1', [fresh.eventId]);
    expect(rows[0]!.n).toBe(1);
  });

  it('stores multiple distinct events in one batch', async () => {
    const tracker = new Tracker();
    const events = [event({ visitorId: 'a' }), event({ visitorId: 'b' }), event({ visitorId: 'c' })];
    const res = await tracker.ingestMany(events);
    expect(res.durable).toBe(true);
    const { rows } = await query('SELECT count(*)::int AS n FROM events WHERE event_id = ANY($1)', [
      events.map((e) => e.eventId),
    ]);
    expect(rows[0]!.n).toBe(3);
  });

  it('accepts an empty batch without touching the database', async () => {
    const tracker = new Tracker();
    const res = await tracker.ingestMany([]);
    expect(res).toEqual({ durable: true, duplicate: false });
  });

  it('stores a conversion with its goal', async () => {
    const tracker = new Tracker();
    const e = event({ type: 'conversion', goal: 'signup' });
    await tracker.ingest(e);
    const { rows } = await query('SELECT type, goal FROM events WHERE event_id = $1', [e.eventId]);
    expect(rows[0]).toMatchObject({ type: 'conversion', goal: 'signup' });
  });

  it('stores event properties as jsonb', async () => {
    const tracker = new Tracker();
    const e = event({ properties: { plan: 'pro', seats: 5 } });
    await tracker.ingest(e);
    const { rows } = await query('SELECT properties FROM events WHERE event_id = $1', [e.eventId]);
    expect(rows[0]!.properties).toMatchObject({ plan: 'pro', seats: 5 });
  });

  it('clamps a wildly wrong client clock into the allowed window', async () => {
    const tracker = new Tracker();
    // 1970. Without clamping this would corrupt every results window.
    const ancient = event({ ts: 0 });
    const future = event({ ts: Date.now() + 1000 * 60 * 60 * 24 * 365 * 10 });
    await tracker.ingestMany([ancient, future]);

    for (const e of [ancient, future]) {
      const { rows } = await query('SELECT ts FROM events WHERE event_id = $1', [e.eventId]);
      const ts = (rows[0]!.ts as Date).getTime();
      const ageMs = Date.now() - ts;
      expect(ageMs).toBeGreaterThanOrEqual(0);
      expect(ageMs).toBeLessThanOrEqual(25 * 60 * 60 * 1000);
    }
  });

  it('preserves a plausible client clock', async () => {
    const tracker = new Tracker();
    const ts = Date.now() - 60_000;
    const e = event({ ts });
    await tracker.ingest(e);
    const { rows } = await query('SELECT ts FROM events WHERE event_id = $1', [e.eventId]);
    expect(Math.abs((rows[0]!.ts as Date).getTime() - ts)).toBeLessThan(2000);
  });
});

describe('Tracker failure handling', () => {
  it('queues and retries an event when the write fails', async () => {
    const tracker = new Tracker({ writeTimeoutMs: 50, retryIntervalMs: 50 });
    // Point at a port with nothing on it, so every write fails fast.
    setEnv({ ...TEST_ENV, DATABASE_URL: 'postgres://variant:variant@127.0.0.1:55999/variant' });
    const { closePool } = await import('../src/db/pool.js');
    await closePool();

    const e = event();
    const res = await tracker.ingest(e);
    expect(res.durable).toBe(false);
    expect(tracker.stats().queued).toBe(1);
    expect(tracker.stats().queueDepth).toBe(1);

    // Restore a working database and let the retry drain it.
    setEnv(TEST_ENV);
    const { closePool: close2 } = await import('../src/db/pool.js');
    await close2();
    await tracker.drain();

    expect(tracker.stats().queueDepth).toBe(0);
    const { rows } = await query('SELECT count(*)::int AS n FROM events WHERE event_id = $1', [e.eventId]);
    expect(rows[0]!.n).toBe(1);
  });

  it('never throws or rejects when the database is unreachable', async () => {
    const tracker = new Tracker({ writeTimeoutMs: 30, queueMax: 5 });
    setEnv({ ...TEST_ENV, DATABASE_URL: 'postgres://variant:variant@127.0.0.1:55999/variant' });
    const { closePool } = await import('../src/db/pool.js');
    await closePool();

    // A tracking failure must not be able to surface as a 500 to a customer's page.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => tracker.ingest(event())),
    );
    for (const r of results) expect(r.durable).toBe(false);
    expect(tracker.stats().failed).toBe(5);

    setEnv(TEST_ENV);
    const { closePool: close2 } = await import('../src/db/pool.js');
    await close2();
  });

  // An unbounded retry queue turns a database brownout into an out-of-memory kill,
  // which would take assignment down too. Dropping is the contained failure.
  it('drops events rather than growing without bound', async () => {
    const tracker = new Tracker({ writeTimeoutMs: 20, queueMax: 3 });
    setEnv({ ...TEST_ENV, DATABASE_URL: 'postgres://variant:variant@127.0.0.1:55999/variant' });
    const { closePool } = await import('../src/db/pool.js');
    await closePool();

    for (let i = 0; i < 10; i++) await tracker.ingest(event({ visitorId: `drop-${i}` }));

    const stats = tracker.stats();
    expect(stats.queueDepth).toBe(3);
    expect(stats.dropped).toBe(7);

    setEnv(TEST_ENV);
    const { closePool: close2 } = await import('../src/db/pool.js');
    await close2();
  });

  it('honours the write timeout instead of waiting forever', async () => {
    // 200ms budget against a black-hole address: must return in roughly that long.
    setEnv({ ...TEST_ENV, DATABASE_URL: 'postgres://variant:variant@10.255.255.1:5432/variant' });
    const { closePool } = await import('../src/db/pool.js');
    await closePool();

    const tracker = new Tracker({ writeTimeoutMs: 200, queueMax: 10 });
    const t0 = Date.now();
    await tracker.ingest(event());
    const elapsed = Date.now() - t0;
    // Generous upper bound: the point is that it is bounded at all.
    expect(elapsed).toBeLessThan(2000);

    setEnv(TEST_ENV);
    const { closePool: close2 } = await import('../src/db/pool.js');
    await close2();
  });
});

describe('Tracker counters', () => {
  it('tracks accepted, duplicate and total counts', async () => {
    const tracker = new Tracker();
    const dup = event();
    await tracker.ingest(dup);
    await tracker.ingest(dup);
    await tracker.ingest(event());
    const s = tracker.stats();
    expect(s.accepted).toBe(2);
    expect(s.duplicates).toBe(1);
    expect(s.dropped).toBe(0);
  });
});
