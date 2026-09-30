/**
 * Entrypoint.
 *
 * Shutdown is handled properly on purpose: on a page-render path, a deploy that drops
 * in-flight requests is a deploy that breaks customers' pages. We stop accepting new
 * connections, let in-flight requests finish, flush the tracking queue, then exit.
 */

import { bootstrapEnv } from './config/env.js';
import { buildApp, shutdown } from './server.js';

const env = bootstrapEnv();

const { app, cache, tracker } = await buildApp();

// Warm the pool and verify the schema is present before we accept traffic. Failing here
// means a clean crash and a redeploy, rather than serving 500s to customers.
try {
  const { query } = await import('./db/pool.js');
  await query('SELECT 1 FROM schema_migrations LIMIT 1');
} catch (err) {
  app.log.error({ err: (err as Error).message }, 'database unreachable or not migrated; refusing to start');
  process.exit(1);
}

let shuttingDown = false;
async function onSignal(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  // Bound the wait. If a connection refuses to drain we exit anyway rather than
  // hanging until the orchestrator SIGKILLs us.
  const timer = setTimeout(() => {
    app.log.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 15_000);
  timer.unref();
  try {
    await shutdown(app, cache, tracker);
    clearTimeout(timer);
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void onSignal('SIGTERM'));
process.on('SIGINT', () => void onSignal('SIGINT'));

// An unhandled rejection leaves the process in an unknown state. Log it and exit so the
// orchestrator replaces us with a clean instance.
process.on('unhandledRejection', (reason) => {
  app.log.fatal({ err: reason }, 'unhandled rejection');
  void onSignal('unhandledRejection');
});

try {
  await app.listen({ port: env.PORT, host: env.HOST });
  app.log.info({ port: env.PORT, env: env.NODE_ENV }, 'listening');
} catch (err) {
  app.log.error({ err }, 'failed to listen');
  process.exit(1);
}
