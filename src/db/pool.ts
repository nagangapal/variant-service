/**
 * Postgres access.
 *
 * Deliberately raw `pg` rather than an ORM. The queries in this service are few and
 * performance-sensitive, and the results query is the kind of aggregate that an ORM
 * either cannot express or expresses badly. Hiding that SQL behind a query builder
 * would make the most interesting part of the system impossible to review, and the
 * review *is* the deliverable here.
 */

import pg from 'pg';
import { getEnv } from '../config/env.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pool) return pool;
  const env = getEnv();

  pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
    // Applies to every query on the connection. A runaway results query must not be
    // able to occupy a pool slot indefinitely.
    statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    allowExitOnIdle: env.NODE_ENV === 'test',
  });

  // An idle client erroring (server restart, network reset) emits on the pool. Without
  // a listener this is an unhandled 'error' event and takes the process down.
  pool.on('error', (err) => {
     
    console.error(JSON.stringify({ level: 'error', msg: 'idle pg client error', err: err.message }));
  });

  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  return getPool().query<T>(text, params as never[]);
}

/** Run a set of statements inside a transaction. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is likely already broken; releasing it destroys it, which is
      // the correct outcome.
    }
    throw err;
  } finally {
    client.release();
  }
}
