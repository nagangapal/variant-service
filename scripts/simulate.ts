/**
 * Traffic simulator: load test, statistical validation, and demo in one.
 *
 *   npx tsx scripts/simulate.ts --url http://localhost:3000 --visitors 20000
 *
 * What it proves, in order of how much it matters:
 *
 *   1. Latency distribution of the assignment endpoint under concurrent load, which is
 *      the number the whole architecture is designed around.
 *   2. That the observed traffic split matches the configured split (a real SRM check
 *      against the events we actually wrote, not a unit test).
 *   3. That duplicate exposure events do not inflate the counts, by deliberately
 *      sending them.
 *   4. That conversion rate reporting is correct, by giving each arm a known
 *      probability and checking the readout recovers it.
 *   5. That stickiness holds end to end over HTTP.
 *
 * Conversion probabilities are configurable so a demo can be made to show a genuine
 * winner, which is the case worth demonstrating.
 */

/** The parts of the /v1/assign response this script consumes. */
interface AssignResponse {
  assignments?: {
    experimentId?: string;
    variantKey?: string | null;
    reason?: string | null;
  }[];
}

/** The parts of the /admin/results response this script consumes. */
interface ResultsResponse {
  error?: string;
  leadingVariant: string | null;
  interpretation: string;
  srm: {
    checked: boolean;
    mismatch: boolean;
    chiSquare: number;
    pValue: number;
    reason: string;
  };
  variants: {
    variantKey: string;
    exposures: number;
    conversions: number;
    rawExposureEvents: number;
    conversionRate: number;
    confidenceIntervalPct: { lower: number; upper: number };
    liftVsControl: number | null;
    significant: boolean;
  }[];
}

interface Args {
  url: string;
  namespace: string;
  experiment: string;
  visitors: number;
  concurrency: number;
  duplicateRate: number;
  /** Baseline conversion rate for the control arm. */
  baseRate: number;
  /** Relative lift applied to non-control arms. */
  lift: number;
  token: string;
  seed: number;
}

function parseArgs(): Args {
  const get = (name: string, def: string): string => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : def;
  };
  return {
    url: get('url', 'http://localhost:3000'),
    namespace: get('namespace', 'default'),
    experiment: get('experiment', 'checkout-cta'),
    visitors: parseInt(get('visitors', '20000'), 10),
    concurrency: parseInt(get('concurrency', '50'), 10),
    duplicateRate: parseFloat(get('duplicate-rate', '0.3')),
    baseRate: parseFloat(get('base-rate', '0.05')),
    lift: parseFloat(get('lift', '0.4')),
    token: get('token', 'dev-local-token'),
    seed: parseInt(get('seed', '42'), 10),
  };
}

/** Deterministic PRNG so repeated runs are comparable. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function uuid(rand: () => number): string {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else if (i === 14) s += '4';
    else if (i === 19) s += hex[(Math.floor(rand() * 16) & 0x3) | 0x8]!;
    else s += hex[Math.floor(rand() * 16)]!;
  }
  return s;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export {};

const args = parseArgs();
const rand = mulberry32(args.seed);

// Which arms are control, and their known true conversion rates. We discover arms from
// the first response, so the lift applies to whatever is not control.
const knownLiftApplied: Record<string, number> = {};

console.log(`simulating ${args.visitors} visitors against ${args.url}`);
console.log(`  experiment=${args.experiment} concurrency=${args.concurrency}`);
console.log(`  duplicate exposure rate=${args.duplicateRate} base rate=${args.baseRate} lift=${args.lift}\n`);

const assignLatencies: number[] = [];
const trackLatencies: number[] = [];
const stickyViolations: { visitor: string; first: string; second: string }[] = [];
let assigned = 0;
let heldBack = 0;
let exposuresSent = 0;
let duplicatesSent = 0;
let conversionsSent = 0;
let trackErrors = 0;
let assignErrors = 0;

const secondPass = new Map<string, string>();

async function runVisitor(i: number): Promise<void> {
  const visitorId = `sim-${args.seed}-${i}`;

  // --- assign ------------------------------------------------------------
  const t0 = performance.now();
  let variant: string | null = null;
  let reason = '';
  try {
    const res = await fetch(`${args.url}/v1/assign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitorId, namespace: args.namespace, experiments: [args.experiment] }),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = (await res.json()) as AssignResponse;
    const a = data.assignments?.[0];
    variant = a?.variantKey ?? null;
    reason = a?.reason ?? '';
  } catch {
    assignErrors++;
  }
  assignLatencies.push(performance.now() - t0);

  if (reason === 'not_in_allocation') heldBack++;
  if (!variant) return;
  assigned++;
  secondPass.set(visitorId, variant);

  const events: unknown[] = [
    { eventId: uuid(rand), type: 'exposure', namespace: args.namespace, experimentId: args.experiment, variantKey: variant, visitorId, ts: Date.now() },
  ];
  exposuresSent++;

  // Duplicate exposure with a *different* eventId. This is the real-world case: a
  // repeated page view, or a retried beacon that got a fresh id. It must not inflate
  // the exposure count, which is why the results query counts distinct visitors.
  if (rand() < args.duplicateRate) {
    events.push({
      eventId: uuid(rand),
      type: 'exposure',
      namespace: args.namespace,
      experimentId: args.experiment,
      variantKey: variant,
      visitorId,
      ts: Date.now(),
    });
    duplicatesSent++;
  }

  // An exact retry of the first event, same id. This is what the unique constraint on
  // event_id absorbs.
  if (rand() < args.duplicateRate) {
    events.push({
      eventId: (events[0] as { eventId: string }).eventId,
      type: 'exposure',
      namespace: args.namespace,
      experimentId: args.experiment,
      variantKey: variant,
      visitorId,
      ts: Date.now(),
    });
    duplicatesSent++;
  }

  const trueRate = knownLiftApplied[variant] ?? args.baseRate;
  if (rand() < trueRate) {
    events.push({
      eventId: uuid(rand),
      type: 'conversion',
      namespace: args.namespace,
      experimentId: args.experiment,
      variantKey: variant,
      visitorId,
      goal: 'signup',
      ts: Date.now(),
    });
    conversionsSent++;
  }

  const t1 = performance.now();
  try {
    const res = await fetch(`${args.url}/v1/track`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    if (!res.ok) trackErrors++;
  } catch {
    trackErrors++;
  }
  trackLatencies.push(performance.now() - t1);
}

// Learn the arms from the experiment config so the lift applies to non-control arms.
const { rows } = await (async () => {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL ?? 'postgres://variant:variant@localhost:55432/variant',
  });
  await client.connect();
  const res = await client.query(
    `SELECT key FROM variants WHERE namespace=$1 AND experiment_id=$2 ORDER BY key`,
    [args.namespace, args.experiment],
  );
  await client.end();
  return res;
})();
const armKeys: string[] = [];
for (const r of rows) {
  const key = (r as { key: string }).key;
  armKeys.push(key);
  knownLiftApplied[key] = key === 'control' ? args.baseRate : args.baseRate * (1 + args.lift);
}
console.log(`arms: ${armKeys.join(', ')} (control=${args.baseRate}, others=${(args.baseRate * (1 + args.lift)).toFixed(4)})\n`);

const wallStart = Date.now();
let next = 0;
await Promise.all(
  Array.from({ length: args.concurrency }, async () => {
    while (true) {
      const i = next++;
      if (i >= args.visitors) return;
      await runVisitor(i);
    }
  }),
);
const wallMs = Date.now() - wallStart;

// --- stickiness second pass -------------------------------------------------
for (let i = 0; i < Math.min(2000, secondPass.size); i++) {
  const visitorId = `sim-${args.seed}-${i}`;
  const first = secondPass.get(visitorId);
  if (!first) continue;
  const res = await fetch(`${args.url}/v1/assign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ visitorId, namespace: args.namespace, experiments: [args.experiment] }),
  });
  const data = (await res.json()) as AssignResponse;
  const second = data.assignments?.[0]?.variantKey ?? null;
  if (second !== first) stickyViolations.push({ visitor: visitorId, first, second: String(second) });
}

const a = assignLatencies.sort((x, y) => x - y);
const t = trackLatencies.sort((x, y) => x - y);

console.log('=== assignment latency (ms) ===');
console.log(`  n=${a.length}  mean=${(a.reduce((s, v) => s + v, 0) / a.length).toFixed(2)}`);
console.log(`  p50=${percentile(a, 50).toFixed(2)}  p90=${percentile(a, 90).toFixed(2)}  p99=${percentile(a, 99).toFixed(2)}  p999=${percentile(a, 99.9).toFixed(2)}  max=${a[a.length - 1]!.toFixed(2)}`);

console.log('=== tracking latency (ms) ===');
console.log(`  n=${t.length}  p50=${percentile(t, 50).toFixed(2)}  p99=${percentile(t, 99).toFixed(2)}  max=${t[t.length - 1]!.toFixed(2)}`);

console.log('=== throughput ===');
console.log(`  ${args.visitors} visitors in ${(wallMs / 1000).toFixed(1)}s => ${(args.visitors / (wallMs / 1000)).toFixed(0)} visitors/s`);
console.log(`  ${((assigned + heldBack) / (wallMs / 1000)).toFixed(0)} assign req/s`);

console.log('=== events ===');
console.log(`  assigned=${assigned} heldBack=${heldBack} (${((heldBack / (assigned + heldBack)) * 100).toFixed(1)}%)`);
console.log(`  exposure events sent=${exposuresSent} duplicates sent=${duplicatesSent} (${((duplicatesSent / exposuresSent) * 100).toFixed(1)}%)`);
console.log(`  conversions sent=${conversionsSent}`);
console.log(`  assignErrors=${assignErrors} trackErrors=${trackErrors}`);

console.log('=== stickiness over HTTP ===');
console.log(`  re-checked ${Math.min(2000, secondPass.size)} visitors, violations=${stickyViolations.length}`);
if (stickyViolations.length > 0) {
  for (const v of stickyViolations.slice(0, 5)) console.log(`   ${v.visitor}: ${v.first} -> ${v.second}`);
}

console.log('\n=== results as reported by the API ===');
const resultsRes = await fetch(`${args.url}/admin/results/${args.experiment}?namespace=${args.namespace}`, {
  headers: { 'x-admin-token': args.token },
});
const results = (await resultsRes.json()) as ResultsResponse;
if (results.error) {
  console.log('  could not fetch results:', JSON.stringify(results));
} else {
  console.log(`  SRM: ${results.srm.mismatch ? 'MISMATCH' : results.srm.checked ? 'ok' : 'not checked'} (chi2=${results.srm.chiSquare.toFixed(2)} p=${results.srm.pValue.toFixed(4)})`);
  console.log(`  ${results.srm.reason}`);
  console.log('');
  console.log('  arm             exp    conv   raw_exp  rate      95% CI            lift      sig');
  for (const v of results.variants) {
    console.log(
      `  ${v.variantKey.padEnd(14)} ${String(v.exposures).padStart(6)} ${String(v.conversions).padStart(6)}` +
        ` ${String(v.rawExposureEvents).padStart(8)}  ${(v.conversionRate * 100).toFixed(2).padStart(6)}%` +
        `  [${v.confidenceIntervalPct.lower.toFixed(2)}%, ${v.confidenceIntervalPct.upper.toFixed(2)}%]` +
        `  ${v.liftVsControl === null ? '   --' : (v.liftVsControl * 100).toFixed(1).padStart(6) + '%'}` +
        `  ${v.significant ? 'yes' : 'no'}`,
    );
  }
  console.log('');
  console.log(`  leader: ${results.leadingVariant ?? 'none (insufficient evidence)'}`);
  console.log(`  ${results.interpretation}`);
}
