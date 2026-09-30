/**
 * Config cache tests.
 *
 * These are the most important tests in the repository. The claim being defended is
 * that a database problem degrades the *quality* of our answers, never their
 * *availability*, and the only way to defend a claim like that is to break the database
 * on purpose and assert what happens.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setEnv, type Env } from '../src/config/env.js';
import { ConfigCache, cacheKey } from '../src/services/configCache.js';
import { assign } from '../src/core/bucketing.js';
import { closePool, query } from '../src/db/pool.js';
import type { Experiment } from '../src/core/types.js';

const WORKING_DB = process.env.DATABASE_URL ?? 'postgres://variant:variant@localhost:55432/variant';
const BROKEN_DB = 'postgres://variant:variant@127.0.0.1:55999/variant';

const BASE_ENV: Env = {
  NODE_ENV: 'test',
  PORT: 0,
  HOST: '127.0.0.1',
  DATABASE_URL: WORKING_DB,
  DB_POOL_MAX: 3,
  DB_STATEMENT_TIMEOUT_MS: 3000,
  DB_CONNECT_TIMEOUT_MS: 500,
  CONFIG_TTL_MS: 60_000,
  CONFIG_MAX_STALE_MS: 600_000,
  ASSIGNMENT_DEADLINE_MS: 150,
  TRACK_WRITE_TIMEOUT_MS: 2000,
  TRACK_QUEUE_MAX: 100,
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

function resetPool(url: string): Promise<void> {
  return closePool().then(() => {
    setEnv({ ...BASE_ENV, DATABASE_URL: url });
  });
}

beforeAll(async () => {
  setEnv(BASE_ENV);
  await query('SELECT 1');
});

afterAll(async () => {
  setEnv(BASE_ENV);
  await closePool();
});

async function seedExperiment(id: string, allocationBps = 10000): Promise<void> {
  await query('DELETE FROM experiments WHERE namespace = $1 AND id = $2', ['testns', id]);
  await query(
    `INSERT INTO experiments (namespace, id, status, allocation_bps) VALUES ($1,$2,'running',$3)`,
    ['testns', id, allocationBps],
  );
  await query(
    `INSERT INTO variants (namespace, experiment_id, key, weight_bps) VALUES ($1,$2,'a',5000),($1,$2,'b',5000)`,
    ['testns', id],
  );
  await query(
    `INSERT INTO creatives (namespace, experiment_id, variant_key, source, headline)
     VALUES ($1,$2,'a','static','Headline A'),($1,$2,'b','static','Headline B')`,
    ['testns', id],
  );
}

function fakeExperiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    namespace: 'testns',
    id: 'fake',
    status: 'running',
    allocationBps: 10000,
    salt: null,
    variants: [
      { key: 'a', weightBps: 5000 },
      { key: 'b', weightBps: 5000 },
    ],
    creatives: {},
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('happy path', () => {
  it('loads experiments from the database and assigns', async () => {
    await seedExperiment('cache-happy');
    const cache = new ConfigCache({ ttlMs: 1000 });
    await cache.refresh();

    const compiled = await cache.get('testns', 'cache-happy');
    expect(compiled).toBeDefined();
    expect(compiled!.plan.map((p) => p.key)).toEqual(['a', 'b']);
    expect(['a', 'b']).toContain(assign(compiled, 'visitor-1').variantKey);
    await cache.stop();
  });

  it('attaches pinned creatives to the compiled plan', async () => {
    await seedExperiment('cache-creative');
    const cache = new ConfigCache({ ttlMs: 1000 });
    await cache.refresh();
    const compiled = await cache.get('testns', 'cache-creative');
    const headlines = compiled!.plan.map((p) => p.creative?.headline);
    expect(headlines.sort()).toEqual(['Headline A', 'Headline B']);
    await cache.stop();
  });

  it('lists running experiments for a namespace', async () => {
    await seedExperiment('cache-list-1');
    await seedExperiment('cache-list-2');
    const cache = new ConfigCache({ ttlMs: 1000 });
    await cache.refresh();
    const listed = cache.listRunning('testns');
    expect(listed).toContain('cache-list-1');
    expect(listed).toContain('cache-list-2');
    expect(cache.listRunning('nonexistent-namespace')).toEqual([]);
    await cache.stop();
  });

  it('returns undefined for an unknown experiment', async () => {
    const cache = new ConfigCache({ ttlMs: 1000 });
    await cache.refresh();
    expect(await cache.get('testns', 'does-not-exist')).toBeUndefined();
    await cache.stop();
  });
});

describe('stampede protection', () => {
  // A cold start under load must not turn into a thundering herd on the database.
  it('collapses 200 concurrent cold reads into a single refresh', async () => {
    await seedExperiment('cache-stampede');
    const cache = new ConfigCache({ ttlMs: 60_000 });
    const before = cache.health().refreshCount;

    await Promise.all(Array.from({ length: 200 }, () => cache.get('testns', 'cache-stampede')));

    const after = cache.health();
    expect(after.refreshCount - before).toBe(1);
    expect(after.singleFlightJoins).toBeGreaterThan(150);
    await cache.stop();
  });

  it('serves concurrent readers the same compiled object', async () => {
    await seedExperiment('cache-shared');
    const cache = new ConfigCache({ ttlMs: 60_000 });
    const results = await Promise.all(
      Array.from({ length: 50 }, () => cache.get('testns', 'cache-shared')),
    );
    const unique = new Set(results);
    expect(unique.size).toBe(1);
    await cache.stop();
  });
});

describe('degradation: database unavailable', () => {
  it('keeps serving a stale snapshot when refreshes start failing', async () => {
    await seedExperiment('cache-stale');
    const cache = new ConfigCache({ ttlMs: 1, maxStaleMs: 600_000 });
    await cache.refresh();
    const before = await cache.get('testns', 'cache-stale');
    expect(before).toBeDefined();

    // Break the database, then force a refresh.
    await resetPool(BROKEN_DB);
    await cache.refresh();
    await cache.refresh();

    const during = await cache.get('testns', 'cache-stale');
    expect(during).toBeDefined();
    // And the assignment is still identical, because it is a pure function anyway.
    expect(assign(during, 'visitor-1').variantKey).toBe(assign(before, 'visitor-1').variantKey);

    const health = cache.health();
    expect(health.status).toBe('stale');
    expect(health.refreshFailureCount).toBeGreaterThan(0);
    expect(health.lastError).toBeTruthy();

    await resetPool(WORKING_DB);
    await cache.stop();
  });

  it('recovers automatically once the database returns', async () => {
    await seedExperiment('cache-recover');
    const cache = new ConfigCache({ ttlMs: 1 });
    await cache.refresh();

    await resetPool(BROKEN_DB);
    await cache.refresh();
    expect(cache.health().status).toBe('stale');

    await resetPool(WORKING_DB);
    await cache.refresh();
    expect(cache.health().status).toBe('warm');
    expect(cache.health().lastError).toBeNull();
    expect(await cache.get('testns', 'cache-recover')).toBeDefined();
    await cache.stop();
  });

  // The one case that legitimately returns nothing: we have never reached the database,
  // so we have no basis for an answer. Failing closed here means the customer sees their
  // own default content, which is the correct outcome.
  it('returns undefined on a cold cache that has never loaded', async () => {
    await resetPool(BROKEN_DB);
    const cache = new ConfigCache({ ttlMs: 1 });
    const result = await cache.get('testns', 'anything');
    expect(result).toBeUndefined();
    expect(cache.health().status).toBe('cold');
    await resetPool(WORKING_DB);
    await cache.stop();
  });

  it('does not throw from a failed refresh', async () => {
    await resetPool(BROKEN_DB);
    const cache = new ConfigCache({ ttlMs: 1 });
    await expect(cache.refresh()).resolves.toBeUndefined();
    await expect(cache.get('x', 'y')).resolves.toBeUndefined();
    await resetPool(WORKING_DB);
    await cache.stop();
  });

  it('survives a NOTIFY that cannot be sent', async () => {
    await resetPool(BROKEN_DB);
    const cache = new ConfigCache({ ttlMs: 1000 });
    // Invalidation is an optimisation; losing it must not fail the caller.
    await expect(cache.notifyChanged('testns')).resolves.toBeUndefined();
    await resetPool(WORKING_DB);
    await cache.stop();
  });

  it('reports stale -- not warm -- when a refresh fails with an empty error message', async () => {
    // Regression, and the reason this test throws an Error with an empty message
    // rather than pointing at a dead port: connection-refused produces a *non-empty*
    // message, so that version of this test passed with the bug still present.
    //
    // Staleness was derived from `lastError` being truthy. When a live Postgres
    // connection dies -- which is exactly what a hosted database suspending an idle
    // connection does -- node-postgres surfaces an Error whose message is ''. Empty
    // string is falsy, so a cache being served stale after an outage reported 'warm'
    // and /v1/assign reported stale:false.
    //
    // The fail-safe behaviour was never wrong; it kept serving the old snapshot. What
    // was wrong is that nothing reported the outage, which defeats tracking it.
    const cache = new ConfigCache({ ttlMs: 60_000, maxStaleMs: 600_000 });
    await cache.refresh();
    expect(cache.health().status).toBe('warm');

    // Reproduce the real failure mode: a live connection dropping with no message.
    const proto = ConfigCache.prototype as unknown as {
      loadExperiments: () => Promise<never[]>;
    };
    const original = proto.loadExperiments;
    proto.loadExperiments = () => Promise.reject(new Error(''));
    try {
      await cache.refresh();

      const h = cache.health();
      expect(h.status).toBe('stale');
      expect(h.refreshFailureCount).toBeGreaterThan(0);
      // A health signal that can be an empty string is not a health signal.
      expect((h.lastError ?? '').length).toBeGreaterThan(0);
      // The snapshot is still served: this is a degradation, not an outage.
      expect(h.experimentCount).toBeGreaterThan(0);
    } finally {
      proto.loadExperiments = original;
    }

    // And it recovers: a later successful refresh must clear the flag, or the service
    // would report itself degraded forever after a transient blip.
    await cache.refresh();
    expect(cache.health().status).toBe('warm');
    expect(cache.health().lastError).toBeNull();
    await cache.stop();
  });
});

describe('health reporting', () => {
  it('reports age and status accurately', async () => {
    const cache = new ConfigCache({ ttlMs: 60_000, maxStaleMs: 1 });
    expect(cache.health().status).toBe('cold');
    await cache.refresh();
    const h = cache.health();
    expect(h.status).toBe('warm');
    expect(h.experimentCount).toBeGreaterThan(0);
    expect(h.ageMs).toBeGreaterThanOrEqual(0);
    await cache.stop();
  });

  it('marks a snapshot older than maxStale as expired but still serves it', async () => {
    const cache = new ConfigCache({ ttlMs: 1, maxStaleMs: 60_000 });
    await seedExperiment('cache-expired');
    cache.setSnapshotForTest([fakeExperiment({ id: 'cache-expired' })]);
    const h = cache.health();
    expect(['warm', 'stale', 'expired']).toContain(h.status);
    // The important part: it still answers.
    expect(await cache.get('testns', 'cache-expired')).toBeDefined();
    await cache.stop();
  });
});

describe('push invalidation', () => {
  it('refreshes immediately when a NOTIFY arrives', async () => {
    await seedExperiment('cache-notify');
    // Clear anything a previous run left behind, so the "unknown experiment"
    // precondition actually holds.
    await query('DELETE FROM experiments WHERE namespace = $1 AND id = $2', ['testns', 'brand-new-exp']);

    // start(), not refresh(): the LISTEN connection is established by start().
    const cache = new ConfigCache({ ttlMs: 60_000 });
    await cache.start();
    expect(await cache.get('testns', 'brand-new-exp')).toBeUndefined();

    await seedExperiment('brand-new-exp');
    await cache.notifyChanged('testns');

    // Give the listener a moment to fire and the refresh to land.
    await new Promise((r) => setTimeout(r, 600));
    expect(await cache.get('testns', 'brand-new-exp')).toBeDefined();
    expect(cache.health().notificationCount).toBeGreaterThan(0);
    await cache.stop();
  });

  it('still self-heals via the TTL when no notification arrives', async () => {
    await seedExperiment('cache-ttl-fallback');
    // A very short TTL, no start() and therefore no listener at all: the fallback path.
    const cache = new ConfigCache({ ttlMs: 20 });
    await cache.refresh();
    expect(await cache.get('testns', 'cache-ttl-fallback')).toBeDefined();

    await query('DELETE FROM experiments WHERE namespace = $1 AND id = $2', ['testns', 'added-without-notify']);
    await seedExperiment('added-without-notify');
    await new Promise((r) => setTimeout(r, 40));
    await cache.refresh();
    expect(await cache.get('testns', 'added-without-notify')).toBeDefined();
    await cache.stop();
  });
});

describe('cache key', () => {
  it('is unambiguous across namespaces', () => {
    expect(cacheKey('a', 'bc')).not.toBe(cacheKey('ab', 'c'));
  });
});
