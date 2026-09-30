/**
 * End-to-end API tests.
 *
 * These exercise the contract a customer's snippet actually depends on. The recurring
 * theme is the fail-safe guarantee: the assignment endpoint must answer 200 with a
 * well-formed body in every situation, including situations that are our fault.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { setEnv, type Env } from '../src/config/env.js';
import { buildApp } from '../src/server.js';
import { closePool, query } from '../src/db/pool.js';

const NS = 'apitest';

const TEST_ENV: Env = {
  NODE_ENV: 'test',
  PORT: 0,
  HOST: '127.0.0.1',
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://variant:variant@localhost:55432/variant',
  DB_POOL_MAX: 5,
  DB_STATEMENT_TIMEOUT_MS: 5000,
  DB_CONNECT_TIMEOUT_MS: 3000,
  CONFIG_TTL_MS: 200,
  CONFIG_MAX_STALE_MS: 600_000,
  ASSIGNMENT_DEADLINE_MS: 150,
  TRACK_WRITE_TIMEOUT_MS: 3000,
  TRACK_QUEUE_MAX: 1000,
  TRACK_RETRY_INTERVAL_MS: 500,
  ADMIN_TOKEN: 'test-admin-token',
  LLM_PROVIDER: 'none',
  LLM_API_KEY: '',
  LLM_MODEL: '',
  LLM_BASE_URL: '',
  LLM_TIMEOUT_MS: 1000,
  LLM_MAX_CANDIDATES: 3,
  LOG_LEVEL: 'silent',
  PUBLIC_BASE_URL: '',
};

let app: FastifyInstance;
const auth = { 'x-admin-token': 'test-admin-token' };

beforeAll(async () => {
  setEnv(TEST_ENV);
  await query('SELECT 1');
  const built = await buildApp({ startBackground: true });
  app = built.app;
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await closePool();
});

beforeEach(async () => {
  await query('DELETE FROM events WHERE namespace = $1', [NS]);
  await query('DELETE FROM experiments WHERE namespace = $1', [NS]);
});

async function createExperiment(body: Record<string, unknown>): Promise<unknown> {
  const res = await app.inject({
    method: 'POST',
    url: `/admin/experiments?namespace=${NS}`,
    headers: auth,
    payload: { namespace: NS, ...body },
  });
  return res.json();
}

async function assign(visitorId: string, experiments?: string[]) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/assign',
    payload: { visitorId, namespace: NS, ...(experiments ? { experiments } : {}) },
  });
  return { status: res.statusCode, body: res.json() };
}

describe('admin auth', () => {
  it('rejects an unauthenticated create', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/experiments', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/experiments',
      headers: { 'x-admin-token': 'wrong' },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the correct token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/experiments?namespace=${NS}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
  });

  it('protects the results endpoint', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/results/whatever' });
    expect(res.statusCode).toBe(401);
  });
});

describe('experiment lifecycle', () => {
  it('creates a static experiment and assigns it', async () => {
    const created = await createExperiment({
      id: 'e1',
      status: 'running',
      allocationBps: 10000,
      variants: [
        { key: 'control', weightBps: 5000, creative: { headline: 'Control headline' } },
        { key: 'treat', weightBps: 5000, creative: { headline: 'Treat headline', cta: 'Go' } },
      ],
    });
    expect((created as { id: string }).id).toBe('e1');

    // Push invalidation is async relative to the test, so give the cache a beat.
    await new Promise((r) => setTimeout(r, 500));

    const { status, body } = await assign('visitor-1', ['e1']);
    expect(status).toBe(200);
    const a = body.assignments[0];
    expect(['control', 'treat']).toContain(a.variantKey);
    expect(['Control headline', 'Treat headline']).toContain(a.payload.headline);
  });

  it('rejects a duplicate experiment id', async () => {
    await createExperiment({
      id: 'dupe',
      variants: [{ key: 'a', weightBps: 1, creative: { headline: 'x' } }],
    });
    const second = await createExperiment({
      id: 'dupe',
      variants: [{ key: 'a', weightBps: 1, creative: { headline: 'x' } }],
    });
    expect((second as { error: string }).error).toBe('already_exists');
  });

  it('rejects invalid weights', async () => {
    const r = await createExperiment({
      id: 'zeroweight',
      variants: [{ key: 'a', weightBps: 0, creative: { headline: 'x' } }],
    });
    expect((r as { error: string }).error).toBe('invalid_experiment');
  });

  it('rejects duplicate variant keys', async () => {
    const r = await createExperiment({
      id: 'dupkeys',
      variants: [
        { key: 'a', weightBps: 1, creative: { headline: 'x' } },
        { key: 'a', weightBps: 1, creative: { headline: 'y' } },
      ],
    });
    expect((r as { error: string }).error).toBe('invalid_experiment');
  });

  it('rejects a variant with no creative and no brief', async () => {
    const r = await createExperiment({
      id: 'nocreative',
      variants: [{ key: 'a', weightBps: 1 }],
    });
    expect((r as { error: string }).error).toBe('invalid_experiment');
  });

  it('keeps an explicitly supplied creative verbatim even when a brief is present', async () => {
    // Regression: an explicit creative used to be treated as a fallback that
    // generation silently overwrote. That defeats the point of pinning a fixed
    // control arm, and the operator would only find out by reading the response.
    const body = (await createExperiment({
      id: 'fixedcontrol',
      creativeBrief: {
        objective: 'drive a demo request',
        audience: 'engineering managers',
        tone: 'direct',
      },
      variants: [
        { key: 'control', weightBps: 5000, creative: { headline: 'Exactly this headline', cta: 'Exact CTA' } },
        { key: 'treat', weightBps: 5000 },
      ],
    })) as { creatives?: { variantKey: string; headline: string; cta?: string; source: string }[] };

    const control = body.creatives?.find((c) => c.variantKey === 'control');
    expect(control?.headline).toBe('Exactly this headline');
    expect(control?.cta).toBe('Exact CTA');
    expect(control?.source).toBe('static');
  });

  it('never serves the variant key as a headline when generation is unavailable', async () => {
    // LLM_PROVIDER is 'none' in this suite, so every generation attempt degrades. The
    // fallback used to be the literal variant key, which put strings like
    // "social-proof" on the customer page as visible headline text.
    const body = (await createExperiment({
      id: 'nokeyheadline',
      creativeBrief: { objective: 'drive signups', audience: 'developers', tone: 'direct' },
      variants: [
        { key: 'social-proof', weightBps: 5000 },
        { key: 'urgency', weightBps: 5000 },
      ],
    })) as { creatives?: { variantKey: string; headline: string; source: string }[] };

    expect(body.creatives?.length).toBe(2);
    for (const c of body.creatives ?? []) {
      expect(c.source).toBe('fallback');
      expect(c.headline).not.toBe(c.variantKey);
      expect(c.headline.length).toBeGreaterThan(0);
    }
  });

  it('refuses to start an experiment running on placeholder copy', async () => {
    // Generation is unavailable in this suite, so the arms hold fallback copy. Starting
    // would compare a real headline against filler and burn traffic to learn nothing.
    await createExperiment({
      id: 'placeholderstart',
      creativeBrief: { objective: 'drive signups', audience: 'developers', tone: 'direct' },
      variants: [
        { key: 'control', weightBps: 5000 },
        { key: 'treat', weightBps: 5000 },
      ],
    });
    const res = await app.inject({
      method: 'POST',
      url: `/admin/experiments/placeholderstart/start?namespace=${NS}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('placeholder_creative');
  });

  it('refuses to start an experiment with no variants', async () => {
    await createExperiment({
      id: 'toostart',
      variants: [{ key: 'a', weightBps: 1, creative: { headline: 'x' } }],
    });
    await query('DELETE FROM variants WHERE namespace=$1 AND experiment_id=$2', [NS, 'toostart']);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/experiments/toostart/start?namespace=${NS}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_variants');
  });

  it('refuses to start an experiment with a missing creative', async () => {
    await createExperiment({
      id: 'halfcreative',
      variants: [
        { key: 'a', weightBps: 1, creative: { headline: 'x' } },
        { key: 'b', weightBps: 1, creative: { headline: 'y' } },
      ],
    });
    await query('DELETE FROM creatives WHERE namespace=$1 AND experiment_id=$2 AND variant_key=$3', [
      NS, 'halfcreative', 'b',
    ]);
    const res = await app.inject({
      method: 'POST',
      url: `/admin/experiments/halfcreative/start?namespace=${NS}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('missing_creative');
  });

  it('pauses an experiment and stops assigning it', async () => {
    await createExperiment({
      id: 'pausable',
      status: 'running',
      variants: [
        { key: 'a', weightBps: 1, creative: { headline: 'x' } },
        { key: 'b', weightBps: 1, creative: { headline: 'y' } },
      ],
    });
    await new Promise((r) => setTimeout(r, 500));
    expect((await assign('v', ['pausable'])).body.assignments[0].variantKey).toBeTruthy();

    const res = await app.inject({
      method: 'POST',
      url: `/admin/experiments/pausable/pause?namespace=${NS}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 500));

    const a = (await assign('v', ['pausable'])).body.assignments[0];
    expect(a.variantKey).toBeNull();
    expect(a.reason).toBe('experiment_paused');
  });
});

describe('assignment endpoint contract', () => {
  beforeEach(async () => {
    await createExperiment({
      id: 'ctr',
      status: 'running',
      variants: [
        { key: 'control', weightBps: 5000, creative: { headline: 'C' } },
        { key: 'treat', weightBps: 5000, creative: { headline: 'T' } },
      ],
    });
    await new Promise((r) => setTimeout(r, 500));
  });

  it('is sticky for the same visitor', async () => {
    const first = (await assign('sticky-visitor', ['ctr'])).body.assignments[0].variantKey;
    for (let i = 0; i < 20; i++) {
      expect((await assign('sticky-visitor', ['ctr'])).body.assignments[0].variantKey).toBe(first);
    }
  });

  // The single most important property of this endpoint.
  it('never returns a non-2xx, even for garbage input', async () => {
    const cases = [{}, { visitorId: '' }, { visitorId: 123 }, { visitorId: 'v', extra: 'field' }];
    for (const payload of cases) {
      const res = await app.inject({ method: 'POST', url: '/v1/assign', payload });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty('assignments');
      expect(Array.isArray(body.assignments)).toBe(true);
    }
  });

  it('answers every requested experiment, including unknown ones', async () => {
    const { body } = await assign('v', ['ctr', 'does-not-exist', 'also-missing']);
    expect(body.assignments).toHaveLength(3);
    expect(body.assignments[0].variantKey).toBeTruthy();
    expect(body.assignments[1].reason).toBe('experiment_not_found');
    expect(body.assignments[2].reason).toBe('experiment_not_found');
  });

  it('assigns all running experiments when none are named', async () => {
    const { body } = await assign('v-auto');
    expect(body.assignments.length).toBeGreaterThanOrEqual(1);
    expect(body.assignments.every((a: { experimentId: string }) => a.experimentId === 'ctr')).toBe(true);
  });

  it('honours a 10% traffic allocation', async () => {
    await createExperiment({
      id: 'holdout',
      status: 'running',
      allocationBps: 1000,
      variants: [
        { key: 'a', weightBps: 5000, creative: { headline: 'A' } },
        { key: 'b', weightBps: 5000, creative: { headline: 'B' } },
      ],
    });
    await new Promise((r) => setTimeout(r, 500));

    let enrolled = 0;
    const N = 1500;
    for (let i = 0; i < N; i++) {
      const a = (await assign(`hold-${i}`, ['holdout'])).body.assignments[0];
      if (a.variantKey) enrolled++;
      else expect(a.reason).toBe('not_in_allocation');
    }
    expect(enrolled / N).toBeGreaterThan(0.05);
    expect(enrolled / N).toBeLessThan(0.15);
  });

  it('works over GET as well as POST', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/assign?visitorId=get-visitor&namespace=${NS}&experiments=ctr`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().assignments[0].variantKey).toBeTruthy();
  });

  it('requires a visitorId on GET', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/assign' });
    expect(res.statusCode).toBe(400);
  });
});

describe('tracking endpoint', () => {
  const base = () => ({
    eventId: randomUUID(),
    type: 'exposure',
    namespace: NS,
    experimentId: 'ctr',
    variantKey: 'control',
    visitorId: 'tracker-visitor',
    ts: Date.now(),
  });

  it('accepts a single event', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/track', payload: base() });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(1);
  });

  it('accepts a batch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      payload: { events: [base(), { ...base(), type: 'conversion', goal: 'signup' }] },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().accepted).toBe(2);
  });

  it('reports a retry as a duplicate', async () => {
    const e = base();
    await app.inject({ method: 'POST', url: '/v1/track', payload: e });
    const res = await app.inject({ method: 'POST', url: '/v1/track', payload: e });
    expect(res.json().duplicates).toBe(1);
  });

  it('rejects a malformed event with a 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/track', payload: { type: 'exposure' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown event type', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/track', payload: { ...base(), type: 'click' } });
    expect(res.statusCode).toBe(400);
  });

  it('accepts a text/plain beacon body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/beacon',
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify(base()),
    });
    expect(res.statusCode).toBe(202);
  });

  it('always returns 202 rather than surfacing a storage failure', async () => {
    // Even a nonsense experiment id is stored fine; the contract is that the client
    // never sees a 5xx from tracking.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/track',
      payload: { ...base(), experimentId: 'nonexistent' },
    });
    expect(res.statusCode).toBe(202);
  });
});

describe('results endpoint', () => {
  it('reports zeros for an experiment with no traffic', async () => {
    await createExperiment({
      id: 'quiet',
      status: 'running',
      variants: [
        { key: 'control', weightBps: 5000, creative: { headline: 'C' } },
        { key: 'treat', weightBps: 5000, creative: { headline: 'T' } },
      ],
    });
    const res = await app.inject({
      method: 'GET',
      url: `/admin/results/quiet?namespace=${NS}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.totalExposures).toBe(0);
    expect(r.leadingVariant).toBeNull();
    expect(r.interpretation).toBeTruthy();
  });

  it('404s an unknown experiment', async () => {
    const res = await app.inject({ method: 'GET', url: `/admin/results/nope?namespace=${NS}`, headers: auth });
    expect(res.statusCode).toBe(404);
  });

  it('counts unique visitors, not raw events', async () => {
    await createExperiment({
      id: 'dedup',
      status: 'running',
      variants: [
        { key: 'control', weightBps: 5000, creative: { headline: 'C' } },
        { key: 'treat', weightBps: 5000, creative: { headline: 'T' } },
      ],
    });
    await new Promise((r) => setTimeout(r, 400));

    // One visitor, ten exposure beacons.
    const events = Array.from({ length: 10 }, () => ({
      eventId: randomUUID(),
      type: 'exposure',
      namespace: NS,
      experimentId: 'dedup',
      variantKey: 'control',
      visitorId: 'repeat-visitor',
      ts: Date.now(),
    }));
    await app.inject({ method: 'POST', url: '/v1/track', payload: { events } });

    const r = (
      await app.inject({ method: 'GET', url: `/admin/results/dedup?namespace=${NS}`, headers: auth })
    ).json();
    const control = r.variants.find((v: { variantKey: string }) => v.variantKey === 'control');
    expect(control.exposures).toBe(1);
    expect(control.rawExposureEvents).toBe(10);
  });

  it('does not credit a conversion with no matching exposure', async () => {
    await createExperiment({
      id: 'attrib',
      status: 'running',
      variants: [
        { key: 'control', weightBps: 5000, creative: { headline: 'C' } },
        { key: 'treat', weightBps: 5000, creative: { headline: 'T' } },
      ],
    });
    await new Promise((r) => setTimeout(r, 400));

    // Expose one visitor, convert a *different* one who was never exposed.
    await app.inject({
      method: 'POST',
      url: '/v1/track',
      payload: { events: [
        { eventId: randomUUID(), type: 'exposure', namespace: NS, experimentId: 'attrib', variantKey: 'control', visitorId: 'exposed-one' },
        { eventId: randomUUID(), type: 'conversion', namespace: NS, experimentId: 'attrib', variantKey: 'control', visitorId: 'never-exposed' },
      ] },
    });

    const r = (
      await app.inject({ method: 'GET', url: `/admin/results/attrib?namespace=${NS}`, headers: auth })
    ).json();
    const control = r.variants.find((v: { variantKey: string }) => v.variantKey === 'control');
    expect(control.exposures).toBe(1);
    expect(control.conversions).toBe(0);
    expect(control.unattributedConversions).toBe(1);
  });
});

describe('health endpoints', () => {
  it('serves liveness without touching the database', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('serves readiness with cache and tracker detail', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.config).toHaveProperty('status');
    expect(r.tracker).toHaveProperty('accepted');
    expect(r.db.ok).toBe(true);
  });
});

describe('static assets', () => {
  it('serves the client snippet', async () => {
    const res = await app.inject({ method: 'GET', url: '/snippet.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    expect(res.body).toContain('AbortController');
  });

  it('serves the demo page', async () => {
    const res = await app.inject({ method: 'GET', url: '/demo' });
    expect(res.statusCode).toBe(200);
  });

  it('serves the dashboard', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('variant-service');
  });

  it('404s an unknown path', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
  });
});
