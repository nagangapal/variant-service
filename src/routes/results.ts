/**
 * Results and health endpoints.
 *
 * Results are not latency critical, so unlike assignment they are allowed to be slow
 * and to fail loudly. A dashboard that shows a stale number without saying so is worse
 * than one that shows an error.
 */

import type { FastifyInstance } from 'fastify';
import { getExperimentResults } from '../services/results.js';
import type { ConfigCache } from '../services/configCache.js';
import type { Tracker } from '../services/tracker.js';
import { requireAdmin } from './experiments.js';

export function registerResultsRoutes(
  app: FastifyInstance,
  cache: ConfigCache,
  tracker: Tracker,
  startedAt: number,
  dbPing: () => Promise<{ ok: boolean; latencyMs: number | null; error: string | null }>,
): void {
  app.get('/admin/results/:id', async (req, reply) => {
    if (!requireAdmin(req as unknown as { headers: Record<string, unknown> })) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { id } = req.params as { id: string };
    const q = req.query as { namespace?: string; since?: string; goal?: string };
    const ns = q.namespace ?? 'default';

    let since: Date | null = null;
    if (q.since) {
      const d = new Date(q.since);
      if (Number.isNaN(d.getTime())) {
        return reply.code(400).send({ error: 'invalid_since' });
      }
      since = d;
    }

    const result = await getExperimentResults({ namespace: ns, experimentId: id, since, goal: q.goal ?? null });
    if (!result) return reply.code(404).send({ error: 'not_found' });
    return reply.send(result);
  });

  /**
   * Liveness. Never touches the database: a liveness probe that fails on a dependency
   * causes the orchestrator to kill an instance that is still perfectly able to serve
   * from its config cache. Killing it would turn a database blip into a total outage.
   */
  app.get('/healthz', async () => ({ status: 'ok', uptimeMs: Date.now() - startedAt }));

  /**
   * Readiness. Reports the config cache honestly, because readiness here means "can
   * this instance answer correctly" rather than "is it connected to Postgres".
   */
  app.get('/readyz', async (_req, reply) => {
    const cacheHealth = cache.health();
    const db = await dbPing();
    const body = {
      status: cacheHealth.status === 'cold' && !db.ok ? 'unavailable' : 'ok',
      config: cacheHealth,
      db,
      tracker: tracker.stats(),
      uptimeMs: Date.now() - startedAt,
    };
    return reply.code(body.status === 'unavailable' ? 503 : 200).send(body);
  });
}
