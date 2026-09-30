/**
 * Deterministic, stateless variant assignment.
 *
 * ## Why hashing instead of storing
 *
 * The naive design is a table of (visitor, experiment) -> variant, written on first
 * sight. We reject it for three reasons:
 *
 *   1. It puts a write on the page-render critical path. A page load that must wait on
 *      a database round trip is a page load we can fail.
 *   2. It makes the service stateful, so every instance must share state to stay
 *      consistent. That constrains deploys, scaling, and failover.
 *   3. Its size is O(unique visitors x running experiments). That is the single
 *      largest table in the system and it grows forever, for data that is a pure
 *      function of inputs we already have.
 *
 * Because the variant is a pure function of (namespace, experiment, visitor), it is
 * sticky by construction: it survives restarts, deploys, and horizontal scale with no
 * coordination, because there is no state to coordinate. It is also idempotent, so a
 * retry can never disagree with the original.
 *
 * The cost we accept: we cannot use a stateful algorithm (Bayesian bandits, mutual
 * exclusion between experiments). We address that in DESIGN.md under next steps.
 */

import { createHash } from 'node:crypto';
import {
  BUCKET_COUNT,
  type CompiledExperiment,
  type Creative,
  type Experiment,
  type VariantPlanEntry,
} from './types.js';

/**
 * Field separator for hash inputs. \x1f is an ASCII unit separator, which cannot appear
 * in any of our identifiers, so ("a", "bc") and ("ab", "c") can never collide.
 */
const SEP = '\x1f';

/** 2^32. Used by the multiply-shift reduction below. */
const TWO_32 = 4294967296;

/**
 * 32 bits of SHA-256 over a domain-separated field tuple.
 *
 * SHA-256 is available natively everywhere and is hardware accelerated (SHA-NI) on
 * modern x86 and ARM cores, so it is fast enough for a hot path while giving us a
 * uniform, well-understood distribution. We only take 32 bits, so collision behaviour is
 * irrelevant: a collision would affect one visitor in 4.3 billion.
 */
function hash32(parts: readonly string[]): number {
  const h = createHash('sha256').update(parts.join(SEP)).digest();
  return h.readUInt32BE(0);
}

/**
 * Map a uniform 32-bit value into [0, BUCKET_COUNT).
 *
 * This is Lemire's multiply-shift ("fastrange") rather than a modulo. Both are fine in
 * absolute terms -- the relative non-uniformity of either is on the order of
 * n / 2^32 ~= 2.3e-6 per bucket, roughly four orders of magnitude below the sampling
 * noise of even a 1,000-visitor experiment. We prefer it because it is one multiply
 * instead of a division, and because unlike `%` it never systematically favours low
 * buckets.
 *
 * The product h * 10_000 peaks at ~4.3e13, comfortably inside the 2^53 exact-integer
 * range of a float64, so there is no precision loss in the multiply.
 */
function reduce(h: number): number {
  return Math.floor((h * BUCKET_COUNT) / TWO_32);
}

/**
 * Bucket for the *enrollment* decision.
 *
 * Deliberately a different domain from the variant bucket. Using one hash for both
 * would couple them: an enrolled visitor's variant would then be a function of their
 * rank within the enrolled population, so changing the traffic allocation would
 * reshuffle variants for people who were already in the experiment. With two
 * independent hashes, changing the allocation changes only *who is enrolled* and never
 * *which variant an enrolled visitor sees*.
 */
export function allocationBucket(exp: CompiledExperiment, visitorId: string): number {
  return reduce(hash32([exp.namespace, exp.id, exp.salt, 'alloc', visitorId]));
}

/** Bucket for the variant choice, independent of the enrollment decision. */
export function variantBucket(exp: CompiledExperiment, visitorId: string): number {
  return reduce(hash32([exp.namespace, exp.id, exp.salt, 'var', visitorId]));
}

/**
 * Turn a stored experiment into the pre-computed form used on the hot path.
 *
 * Doing the weight normalisation once per config refresh rather than once per request
 * is most of why the assignment endpoint is cheap: the request does one hash for
 * enrollment, one hash for the variant, and a linear scan of a 2-3 element array.
 */
export function compileExperiment(exp: Experiment): CompiledExperiment {
  const plan: VariantPlanEntry[] = [];
  const creatives = exp.creatives ?? {};

  const total = exp.variants.reduce((sum, v) => sum + v.weightBps, 0);

  if (total > 0) {
    // Variant declaration order is not semantically meaningful, and boundaries are
    // positional, so without this an operator reordering [control, treatment] to
    // [treatment, control] in the config would silently flip every visitor's arm.
    // Sorting by key makes a reorder a genuine no-op. A zero total weight yields an
    // empty plan, which makes the experiment enroll nobody -- the safe reading of
    // "these variants have no weight", as opposed to dumping all traffic into one.
    const ordered = [...exp.variants].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    let cumulative = 0;
    for (const v of ordered) {
      cumulative += v.weightBps;
      plan.push({
        key: v.key,
        cumulativeBps: cumulative === total ? BUCKET_COUNT : Math.round((cumulative / total) * BUCKET_COUNT),
        creative: creatives[v.key] ?? null,
      });
    }
  }

  return {
    namespace: exp.namespace,
    id: exp.id,
    version: exp.version,
    status: exp.status,
    allocationBps: exp.allocationBps,
    salt: exp.salt ?? '',
    plan,
  };
}

export interface AssignmentResult {
  variantKey: string | null;
  creative: Creative | null;
  reason:
    | 'assigned'
    | 'not_in_allocation'
    | 'experiment_paused'
    | 'experiment_not_found'
    | 'experiment_not_running'
    | 'no_variants';
}

/**
 * Assign a visitor. Pure, allocation-free, no I/O.
 *
 * Never throws and never returns a "no answer". If the experiment is missing, paused,
 * or malformed we return a null variant with a reason, which the caller renders as
 * "show the default experience". Failing closed into a default is what keeps a customer
 * page intact when our config is wrong.
 */
export function assign(exp: CompiledExperiment | undefined, visitorId: string): AssignmentResult {
  if (!exp) {
    return { variantKey: null, creative: null, reason: 'experiment_not_found' };
  }
  if (exp.status === 'paused' || exp.status === 'archived') {
    return { variantKey: null, creative: null, reason: 'experiment_paused' };
  }
  if (exp.status !== 'running') {
    return { variantKey: null, creative: null, reason: 'experiment_not_running' };
  }
  if (exp.plan.length === 0) {
    return { variantKey: null, creative: null, reason: 'no_variants' };
  }

  if (allocationBucket(exp, visitorId) >= exp.allocationBps) {
    return { variantKey: null, creative: null, reason: 'not_in_allocation' };
  }

  const b = variantBucket(exp, visitorId);
  // First boundary strictly greater than the bucket wins. A zero-weight variant has a
  // boundary equal to its predecessor's, so it is correctly unreachable.
  for (const entry of exp.plan) {
    if (b < entry.cumulativeBps) {
      return { variantKey: entry.key, creative: entry.creative, reason: 'assigned' };
    }
  }

  // Unreachable because we force the final boundary to BUCKET_COUNT, but a null return
  // would put a visitor outside the experiment on a rounding artefact. Last entry wins.
  const last = exp.plan[exp.plan.length - 1]!;
  return { variantKey: last.key, creative: last.creative, reason: 'assigned' };
}
