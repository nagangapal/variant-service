/**
 * Server construction.
 *
 * Exported separately from the entrypoint so tests can build an app against a real
 * database and a real cache without binding a port or installing signal handlers.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getEnv } from './config/env.js';
import { getPool, query } from './db/pool.js';
import { createProvider } from './llm/provider.js';
import { CreativeGenerator } from './llm/creative.js';
import { ConfigCache } from './services/configCache.js';
import { Tracker } from './services/tracker.js';
import { registerAdminRoutes } from './routes/experiments.js';
import { registerAssignRoutes } from './routes/assign.js';
import { registerResultsRoutes } from './routes/results.js';
import { registerTrackRoutes } from './routes/track.js';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

export interface App {
  app: FastifyInstance;
  cache: ConfigCache;
  tracker: Tracker;
}

export async function buildApp(opts?: { startBackground?: boolean }): Promise<App> {
  const env = getEnv();
  const startedAt = Date.now();

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // Never log visitor ids or bodies. They are customer identifiers and this service
      // is the most likely place for them to end up in a log aggregator.
      redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-admin-token"]', 'body.visitorId', 'body.events'],
    },
    // A hard body cap. The tracking endpoint accepts a visitor-controlled payload and
    // an unbounded body is a trivial memory-exhaustion vector on a critical-path service.
    bodyLimit: 64 * 1024,
    // Generous, but not infinite. requestTimeout exists so a slowloris-style client
    // cannot hold a connection open indefinitely.
    requestTimeout: 10_000,
    trustProxy: true,
    disableRequestLogging: env.NODE_ENV === 'production',
  });

  const cache = new ConfigCache();
  const tracker = new Tracker();
  const generator = new CreativeGenerator(createProvider());

  if (opts?.startBackground !== false) {
    await cache.start();
    await tracker.start();
  }

  const dbPing = async () => {
    const t0 = process.hrtime.bigint();
    try {
      await query('SELECT 1');
      return {
        ok: true,
        latencyMs: Number(process.hrtime.bigint() - t0) / 1e6,
        error: null,
      };
    } catch (err) {
      return { ok: false, latencyMs: null, error: (err as Error).message };
    }
  };

  registerAssignRoutes(app, cache);
  registerTrackRoutes(app, tracker);
  registerAdminRoutes(app, cache, generator);
  registerResultsRoutes(app, cache, tracker, startedAt, dbPing);

  // --- static files, served explicitly ---------------------------------------
  // Two files, so a static plugin would be a dependency with a CVE surface for no
  // benefit. The demo page and snippet are read once at boot and cached in memory.
  const staticFiles: Record<string, { body: string; type: string }> = {};
  const loadStatic = async () => {
    for (const [route, file, type] of [
      ['/demo', 'demo.html', 'text/html; charset=utf-8'],
      ['/snippet.js', 'snippet.js', 'application/javascript; charset=utf-8'],
      ['/dashboard', 'dashboard.html', 'text/html; charset=utf-8'],
    ] as const) {
      try {
        staticFiles[route] = { body: await readFile(join(PUBLIC_DIR, file), 'utf8'), type };
      } catch {
        // A missing optional asset must not prevent boot.
      }
    }
  };
  await loadStatic();

  app.get('/', async (_req, reply) => {
    if (!staticFiles['/dashboard']) return reply.send({ service: 'variant-service', see: '/dashboard' });
    return reply.type(staticFiles['/dashboard'].type).send(staticFiles['/dashboard'].body);
  });

  for (const route of ['/demo', '/snippet.js', '/dashboard']) {
    app.get(route, async (_req, reply) => {
      const f = staticFiles[route];
      if (!f) return reply.code(404).send({ error: 'not_found' });
      return reply.type(f.type).send(f.body);
    });
  }

  // Central error handler. Assignment already handles its own failures, so anything
  // arriving here is a genuine bug: log it fully, return something generic.
  app.setErrorHandler((err, req, reply) => {
    req.log.error({ err }, 'unhandled error');
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    reply.code(status).send({ error: status === 500 ? 'internal_error' : 'bad_request' });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: 'not_found', path: req.url });
  });

  return { app, cache, tracker };
}

export async function shutdown(app: FastifyInstance, cache: ConfigCache, tracker: Tracker): Promise<void> {
  await app.close();
  await cache.stop();
  await tracker.stop();
  const { closePool } = await import('./db/pool.js');
  await closePool();
  void getPool;
}
