/**
 * Control plane: defining and operating experiments.
 *
 * Separated from the data plane by an auth hook rather than by a different service. At
 * this stage a second deployable would be more operational surface than the problem
 * justifies, and the security boundary is enforced in one place instead of being
 * assumed. DESIGN.md describes the split.
 *
 * Every mutation notifies the config cache, so a new experiment is live on every
 * instance within a few milliseconds rather than after a TTL.
 */

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { getEnv } from '../config/env.js';
import { query, withTransaction } from '../db/pool.js';
import type { ConfigCache } from '../services/configCache.js';
import type { CreativeGenerator } from '../llm/creative.js';
import { checkDistinctness } from '../llm/distinctness.js';
import { createExperimentSchema, patchExperimentSchema } from './validation.js';

/** Constant-time-ish comparison so the token cannot be probed byte by byte. */
function tokenMatches(provided: string, expected: string): boolean {
  if (!expected || !provided) return false;
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function requireAdmin(req: { headers: Record<string, unknown> }): boolean {
  const env = getEnv();
  if (!env.ADMIN_TOKEN) return env.NODE_ENV !== 'production';
  const header = req.headers.authorization;
  const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  const xToken = typeof req.headers['x-admin-token'] === 'string' ? (req.headers['x-admin-token'] as string) : '';
  return tokenMatches(bearer || xToken, env.ADMIN_TOKEN);
}

export function registerAdminRoutes(
  app: FastifyInstance,
  cache: ConfigCache,
  generator: CreativeGenerator,
): void {
  const adminOnly = async (req: { headers: Record<string, unknown> }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (!requireAdmin(req)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  };

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------
  app.post('/admin/experiments', { preHandler: adminOnly }, async (req, reply) => {
    const parsed = createExperimentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_experiment',
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const input = parsed.data;
    const env = getEnv();

    // Generation happens here, at creation time, off the hot path. This is the whole
    // design: the assignment endpoint will only ever read the string this produces.
    const creatives = new Map<string, { id: string; source: string; headline: string; cta?: string; body?: string; model: string | null }>();
    const generationLog: unknown[] = [];

    for (const v of input.variants) {
      // An explicitly supplied creative is authoritative and opts that variant out of
      // generation. This is how a fixed control arm is expressed, and quietly
      // overwriting it with model output would be both surprising and wrong -- the
      // operator asked for specific text, not a suggestion.
      if (v.creative) {
        creatives.set(v.key, {
          id: randomUUID(),
          source: 'static',
          headline: v.creative.headline,
          cta: v.creative.cta,
          body: v.creative.body,
          model: null,
        });
        continue;
      }

      if (input.creativeBrief) {
        // Pass the arms already chosen so this one has to be genuinely distinct from
        // them. Without this, a model asked for three different messages will often
        // return the same headline three times.
        const pinnedSoFar = [...creatives.values()].map((c) => ({
          headline: c.headline,
          cta: c.cta,
          body: c.body,
        }));
        const gen = await generator.generateForVariant(input.creativeBrief, v.key, v.creative ?? null, pinnedSoFar);
        generationLog.push({
          variant: v.key,
          provider: gen.provider,
          model: gen.model,
          degraded: gen.degraded,
          degradedReason: gen.degradedReason ?? null,
          candidates: gen.creatives.length,
          usage: gen.usage,
        });
        const best = gen.creatives[0]!;
        creatives.set(v.key, {
          id: best.id,
          source: best.source,
          headline: best.headline,
          cta: best.cta,
          body: best.body,
          model: best.model ?? null,
        });
      } else {
        // Unreachable: validation rejects a variant with neither a creative nor a brief.
        const c = v.creative!;
        creatives.set(v.key, {
          id: randomUUID(),
          source: 'static',
          headline: c.headline,
          cta: c.cta,
          body: c.body,
          model: null,
        });
      }
    }

    try {
      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO experiments (namespace, id, status, allocation_bps, salt)
           VALUES ($1,$2,$3,$4,$5)`,
          [input.namespace, input.id, input.status, input.allocationBps, input.salt ?? null],
        );
        for (const v of input.variants) {
          await client.query(
            `INSERT INTO variants (namespace, experiment_id, key, weight_bps) VALUES ($1,$2,$3,$4)`,
            [input.namespace, input.id, v.key, v.weightBps],
          );
        }
        for (const [variantKey, c] of creatives) {
          await client.query(
            `INSERT INTO creatives (id, namespace, experiment_id, variant_key, source, headline, cta, body, model)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [c.id, input.namespace, input.id, variantKey, c.source, c.headline, c.cta ?? null, c.body ?? null, c.model],
          );
        }
      });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'already_exists', message: `experiment "${input.id}" already exists` });
      }
      throw err;
    }

    await cache.notifyChanged(input.namespace);
    await cache.refresh();

    // Report, but do not block on, whether the arms ended up genuinely distinct. We
    // allow starting a slightly-similar experiment because subtle copy tests are
    // legitimate; we just make sure the operator knows the result will be weak.
    const distinctness = checkDistinctness(
      [...creatives.entries()].map(([key, c]) => ({
        key,
        headline: c.headline,
        cta: c.cta,
        body: c.body,
      })),
    );

    return reply.code(201).send({
      namespace: input.namespace,
      id: input.id,
      status: input.status,
      allocationBps: input.allocationBps,
      variants: input.variants.map((v) => ({ key: v.key, weightBps: v.weightBps })),
      // The pinned copy is returned so the operator sees exactly what will be served
      // without a follow-up request. Model output is worth reviewing before an
      // experiment goes live, and making that require a second call invites skipping it.
      creatives: [...creatives.entries()].map(([variantKey, c]) => ({
        variantKey,
        source: c.source,
        headline: c.headline,
        cta: c.cta ?? null,
        body: c.body ?? null,
        model: c.model,
      })),
      generation: generationLog.length > 0 ? generationLog : 'not requested (static creatives)',
      distinctness,
      llmProvider: env.LLM_PROVIDER,
    });
  });

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------
  app.get('/admin/experiments', { preHandler: adminOnly }, async (req, reply) => {
    const q = req.query as { namespace?: string };
    const ns = q.namespace ?? 'default';
    const { rows } = await query(
      `SELECT e.namespace, e.id, e.status, e.allocation_bps, e.version, e.created_at, e.updated_at,
              COALESCE((SELECT json_agg(json_build_object('key', v.key, 'weightBps', v.weight_bps) ORDER BY v.key)
                          FROM variants v WHERE v.namespace = e.namespace AND v.experiment_id = e.id),'[]') AS variants
         FROM experiments e WHERE e.namespace = $1 ORDER BY e.created_at DESC`,
      [ns],
    );
    return reply.send({ experiments: rows });
  });

  app.get('/admin/experiments/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { namespace?: string };
    const ns = q.namespace ?? 'default';
    const { rows } = await query(
      `SELECT e.*,
              COALESCE((SELECT json_agg(json_build_object('key', v.key, 'weightBps', v.weight_bps) ORDER BY v.key)
                          FROM variants v WHERE v.namespace = e.namespace AND v.experiment_id = e.id),'[]') AS variants,
              COALESCE((SELECT json_agg(json_build_object('variantKey', c.variant_key, 'source', c.source,
                                'headline', c.headline, 'cta', c.cta, 'body', c.body, 'model', c.model) ORDER BY c.variant_key)
                          FROM creatives c WHERE c.namespace = e.namespace AND c.experiment_id = e.id AND c.pinned),'[]') AS creatives
         FROM experiments e WHERE e.namespace = $1 AND e.id = $2`,
      [ns, id],
    );
    const exp = rows[0];
    if (!exp) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ experiment: exp });
  });

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------
  app.patch('/admin/experiments/:id', { preHandler: adminOnly }, async (req, reply) => {
    const parsed = patchExperimentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_patch',
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }
    const { id } = req.params as { id: string };
    const q = req.query as { namespace?: string };
    const ns = q.namespace ?? 'default';
    const patch = parsed.data;

    await withTransaction(async (client) => {
      const sets: string[] = [];
      const params: unknown[] = [];
      let n = 1;
      if (patch.status !== undefined) { sets.push(`status = $${n++}`); params.push(patch.status); }
      if (patch.allocationBps !== undefined) { sets.push(`allocation_bps = $${n++}`); params.push(patch.allocationBps); }
      if (patch.salt !== undefined) { sets.push(`salt = $${n++}`); params.push(patch.salt); }
      if (sets.length) {
        sets.push('version = version + 1', 'updated_at = now()');
        const res = await client.query(
          `UPDATE experiments SET ${sets.join(', ')} WHERE namespace = $${n++} AND id = $${n++}`,
          [...params, ns, id],
        );
        if (res.rowCount === 0) {
          throw Object.assign(new Error('not found'), { statusCode: 404 });
        }
      }
      if (patch.variants) {
        await client.query(`DELETE FROM variants WHERE namespace = $1 AND experiment_id = $2`, [ns, id]);
        for (const v of patch.variants) {
          await client.query(
            `INSERT INTO variants (namespace, experiment_id, key, weight_bps) VALUES ($1,$2,$3,$4)`,
            [ns, id, v.key, v.weightBps],
          );
        }
        await client.query(
          `UPDATE experiments SET version = version + 1, updated_at = now() WHERE namespace = $1 AND id = $2`,
          [ns, id],
        );
      }
    }).catch((err) => {
      if ((err as { statusCode?: number }).statusCode === 404) {
        return reply.code(404).send({ error: 'not_found' });
      }
      throw err;
    });

    await cache.notifyChanged(ns);
    await cache.refresh();
    return reply.send({ ok: true, namespace: ns, id });
  });

  app.post('/admin/experiments/:id/:action', { preHandler: adminOnly }, async (req, reply) => {
    const { id, action } = req.params as { id: string; action: string };
    const q = req.query as { namespace?: string };
    const ns = q.namespace ?? 'default';

    const statuses: Record<string, string> = { start: 'running', pause: 'paused', stop: 'archived' };
    const status = statuses[action];
    if (!status) {
      return reply.code(400).send({ error: 'unknown_action', allowed: Object.keys(statuses) });
    }

    // Refuse to start an experiment with no usable creative. Serving a variant with no
    // content would show the customer a blank block, and they would discover it in
    // production rather than here.
    if (status === 'running') {
      const { rows } = await query(
        `SELECT
           (SELECT count(*)::int FROM variants v WHERE v.namespace=$1 AND v.experiment_id=$2) AS variant_count,
           (SELECT COALESCE(sum(v.weight_bps),0)::int FROM variants v WHERE v.namespace=$1 AND v.experiment_id=$2) AS total_weight,
           (SELECT count(*)::int FROM creatives c WHERE c.namespace=$1 AND c.experiment_id=$2 AND c.pinned) AS creative_count`,
        [ns, id],
      );
      const r = rows[0] as { variant_count: number; total_weight: number; creative_count: number } | undefined;
      if (!r || r.variant_count === 0) {
        return reply.code(409).send({ error: 'no_variants', message: 'experiment has no variants' });
      }
      if (r.total_weight <= 0) {
        return reply.code(409).send({ error: 'zero_weight', message: 'all variant weights are zero' });
      }
      if (r.creative_count < r.variant_count) {
        return reply.code(409).send({
          error: 'missing_creative',
          message: `only ${r.creative_count} of ${r.variant_count} variants have content`,
        });
      }
    }

    const { rowCount } = await query(
      `UPDATE experiments SET status = $1, version = version + 1, updated_at = now()
        WHERE namespace = $2 AND id = $3`,
      [status, ns, id],
    );
    if (rowCount === 0) return reply.code(404).send({ error: 'not_found' });

    await cache.notifyChanged(ns);
    await cache.refresh();
    return reply.send({ ok: true, namespace: ns, id, status });
  });

  /**
   * Regenerate AI copy for every variant.
   *
   * A control-plane operation with an explicit name, so nobody can mistake it for
   * something that runs on the read path. Because creatives are pinned, a successful
   * run swaps the content atomically and assignment keeps working throughout.
   */
  app.post('/admin/experiments/:id/regenerate', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { namespace?: string };
    const ns = q.namespace ?? 'default';
    const body = (req.body ?? {}) as { brief?: unknown };

    if (!generator.available) {
      return reply.code(503).send({
        error: 'llm_unavailable',
        message: `no LLM provider configured (LLM_PROVIDER=${getEnv().LLM_PROVIDER})`,
      });
    }

    const { creativeBriefSchema } = await import('./validation.js');
    const brief = creativeBriefSchema.safeParse(body.brief);
    if (!brief.success) {
      return reply.code(400).send({
        error: 'invalid_brief',
        detail: brief.success ? [] : brief.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
      });
    }

    const { rows } = await query<{ key: string }>(
      `SELECT key FROM variants WHERE namespace = $1 AND experiment_id = $2 ORDER BY key`,
      [ns, id],
    );
    if (rows.length === 0) return reply.code(404).send({ error: 'not_variants' });

    const results: unknown[] = [];
    await withTransaction(async (client) => {
      for (const v of rows) {
        const gen = await generator.generateForVariant(brief.data, v.key, null);
        const best = gen.creatives[0]!;
        results.push({
          variant: v.key,
          degraded: gen.degraded,
          degradedReason: gen.degradedReason ?? null,
          headline: best.headline,
          cta: best.cta ?? null,
        });
        // Unpin then pin inside the transaction, so the partial unique index never
        // sees two pinned rows and a reader never observes a variant with no creative.
        await client.query(
          `UPDATE creatives SET pinned = FALSE, updated_at = now()
            WHERE namespace = $1 AND experiment_id = $2 AND variant_key = $3`,
          [ns, id, v.key],
        );
        if (gen.degraded) continue; // leave the operator's static creative in place
        await client.query(
          `INSERT INTO creatives (id, namespace, experiment_id, variant_key, source, headline, cta, body, model, pinned)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)`,
          [best.id, ns, id, v.key, best.source, best.headline, best.cta ?? null, best.body ?? null, best.model ?? null],
        );
      }
    });

    await cache.notifyChanged(ns);
    await cache.refresh();
    return reply.send({ ok: true, results });
  });
}
