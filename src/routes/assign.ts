/**
 * Assignment: the page-render path.
 *
 * This is the endpoint whose latency and availability are a customer problem rather
 * than our problem, so it is built to a much stricter standard than the rest of the
 * service:
 *
 *  - It never returns a non-2xx. A customer snippet cannot handle an error page, and an
 *    error is indistinguishable from "no experiment" as far as the page is concerned.
 *  - It never throws. A bug in here degrades to no-assignment, not to a 500.
 *  - It holds no locks and touches no database on the steady-state path.
 *  - It answers every requested experiment, including ones it knows nothing about, so
 *    the client can rely on the response shape.
 */

import type { FastifyInstance } from 'fastify';
import { assign } from '../core/bucketing.js';
import type { ConfigCache } from '../services/configCache.js';
import { assignBodySchema, visitorIdSchema, experimentIdSchema, namespaceSchema } from './validation.js';

export interface AssignmentResponseItem {
  experimentId: string;
  variantKey: string | null;
  creativeId: string | null;
  reason: string;
  /** Content to render. Inlined so the snippet needs one round trip, not two. */
  payload: { headline: string; cta?: string; body?: string } | null;
}

export interface AssignmentResponse {
  visitorId: string;
  assignments: AssignmentResponseItem[];
  /** True when the config snapshot is older than the TTL. */
  stale: boolean;
}

export function registerAssignRoutes(app: FastifyInstance, cache: ConfigCache): void {
  const handle = async (
    visitorId: string,
    namespace: string,
    requested: string[] | undefined,
  ): Promise<AssignmentResponse> => {
    // When the caller does not name experiments we enumerate everything running in the
    // namespace. This comes from the already-cached snapshot, so it is free.
    const ids = requested ?? cache.listRunning(namespace);

    const assignments: AssignmentResponseItem[] = [];
    for (const id of ids) {
      // Sequential, not Promise.all: after the first, every lookup is a synchronous Map
      // read, so there is nothing to parallelise and a microtask per experiment would
      // cost more than it saves.
      const compiled = await cache.get(namespace, id);
      const result = assign(compiled, visitorId);
      assignments.push({
        experimentId: id,
        variantKey: result.variantKey,
        creativeId: result.creative?.id ?? null,
        reason: result.reason,
        payload: result.creative
          ? {
              headline: result.creative.headline,
              ...(result.creative.cta ? { cta: result.creative.cta } : {}),
              ...(result.creative.body ? { body: result.creative.body } : {}),
            }
          : null,
      });
    }

    return {
      visitorId,
      assignments,
      // Served from a snapshot that is past its TTL, or from a snapshot that a
      // failed refresh could not improve on. Not merely "some time has passed" --
      // a warm cache is the normal state and reporting it as stale would be noise.
      stale: cache.health().status === 'stale' || cache.health().status === 'expired',
    };
  };

  // POST form. Preferred: one round trip for many experiments, and a body keeps ids out
  // of URLs where they end up in access logs and proxy caches.
  app.post('/v1/assign', async (req, reply) => {
    const parsed = assignBodySchema.safeParse(req.body);
    if (!parsed.success) {
      // Still a 200. The snippet gets a well-formed "no assignment" answer rather than
      // an error shape it would have to special-case.
      return reply.code(200).send({
        visitorId: '',
        assignments: [],
        stale: true,
        error: 'invalid_request',
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    return reply
      .code(200)
      .send(await handle(parsed.data.visitorId, parsed.data.namespace, parsed.data.experiments));
  });

  // GET form, for the simplest possible integration and for easy curl-ing.
  app.get('/v1/assign', async (req, reply) => {
    const q = req.query as { visitorId?: string; namespace?: string; experiments?: string };
    const visitor = visitorIdSchema.safeParse(q.visitorId ?? '');
    if (!visitor.success) {
      return reply.code(400).send({ error: 'visitorId is required' });
    }
    const ns = namespaceSchema.safeParse(q.namespace ?? 'default');
    if (!ns.success) {
      return reply.code(400).send({ error: 'invalid namespace' });
    }
    let idList: string[] | undefined;
    if (q.experiments) {
      const parsed = q.experiments
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => experimentIdSchema.safeParse(s));
      if (parsed.some((r) => !r.success)) {
        return reply.code(400).send({ error: 'invalid experiment id' });
      }
      idList = parsed.map((r) => (r as { data: string }).data).slice(0, 50);
    }
    return reply.code(200).send(await handle(visitor.data, ns.data, idList));
  });
}
