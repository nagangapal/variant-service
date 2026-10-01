/**
 * Connection wiring for the config-invalidation listener.
 *
 * `LISTEN` needs a session. Neon's pooled endpoint is PgBouncer in transaction
 * mode, which cannot hold one, so a listener pointed at the pooled URL connects
 * fine and then silently never receives a notification. Nothing errors; config
 * invalidation just quietly falls back to the TTL, and the bug is invisible until
 * someone notices a change taking up to TTL to propagate.
 *
 * The fix is to let the listener use a direct connection string while query
 * traffic stays pooled. These tests assert the listener is *constructed* with the
 * right string, because that is the only place the choice is made -- if it is
 * wired correctly here, the runtime behaviour follows from pg.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const POOLED = 'postgres://u:p@ep-pooler.region.aws.neon.tech/db?sslmode=require';
const DIRECT = 'postgres://u:p@ep.region.aws.neon.tech/db?sslmode=require';

/** Connection strings every Client constructed during a test. */
const constructed: string[] = [];

vi.mock('pg', () => {
  class FakeClient {
    constructor(cfg: { connectionString: string }) {
      constructed.push(cfg.connectionString);
    }
    on(): this {
      return this;
    }
    async connect(): Promise<void> {}
    async query(): Promise<{ rows: unknown[] }> {
      return { rows: [] };
    }
    async end(): Promise<void> {}
  }
  class FakePool {
    async query(): Promise<{ rows: unknown[] }> {
      return { rows: [] };
    }
    async end(): Promise<void> {}
  }
  return { Client: FakeClient, Pool: FakePool, default: { Client: FakeClient, Pool: FakePool } };
});

// Static imports: vitest hoists vi.mock above them, so the mocks still apply.
import { setEnv, type Env } from '../src/config/env.js';
import { ConfigCache } from '../src/services/configCache.js';

const BASE_ENV = {
  NODE_ENV: 'test',
  PORT: 0,
  HOST: '127.0.0.1',
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
} as const satisfies Omit<Env, 'DATABASE_URL' | 'DATABASE_URL_UNPOOLED'>;

/** Start a cache against a fake database and return the listener's connection string. */
async function listenerConnectionString(
  env: Partial<Env>,
): Promise<string | undefined> {
  constructed.length = 0;
  setEnv({ ...BASE_ENV, DATABASE_URL: POOLED, ...env });
  const cache = new ConfigCache();
  // No database behind the mock, so keep the initial refresh out of it.
  const proto = ConfigCache.prototype as unknown as {
    loadExperiments: () => Promise<never[]>;
  };
  const original = proto.loadExperiments;
  proto.loadExperiments = () => Promise.resolve([]);
  try {
    await cache.start();
    return constructed[0];
  } finally {
    await cache.stop();
    proto.loadExperiments = original;
  }
}

afterEach(() => {
  constructed.length = 0;
});

describe('config listener connection', () => {
  it('uses the direct connection string, never the pooled one', async () => {
    const used = await listenerConnectionString({ DATABASE_URL_UNPOOLED: DIRECT });
    expect(used).toBe(DIRECT);
    // The bug this guards: PgBouncer in transaction mode cannot hold a LISTEN
    // session, so this is not a stylistic preference.
    expect(used).not.toBe(POOLED);
  });

  it('falls back to DATABASE_URL when no direct string is configured', async () => {
    // Keeps single-URL deployments and local Postgres working unchanged.
    const used = await listenerConnectionString({});
    expect(used).toBe(POOLED);
  });

  it('uses the direct string even when it is the only difference', async () => {
    const used = await listenerConnectionString({ DATABASE_URL_UNPOOLED: DIRECT });
    expect(used).toContain('ep.region.aws.neon.tech');
    expect(used).not.toContain('-pooler');
  });
});
