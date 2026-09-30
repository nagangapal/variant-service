/**
 * Experiment readout.
 *
 * Three correctness decisions live here, and each of them exists because the naive
 * version produces numbers that look authoritative and are wrong.
 *
 * 1. UNIQUE VISITORS, NOT EVENTS.
 *    A visitor who sees a page eight times sends eight exposure events. Counting
 *    events would let a conversion rate exceed 100% and would silently bias every
 *    variant toward whichever one happened to be the most heavily loaded. So exposures
 *    and conversions are both counted DISTINCT by visitor, and the raw event count is
 *    reported alongside purely as an operational signal about client behaviour.
 *
 * 2. CONVERSIONS WITHOUT AN EXPOSURE ARE NOT CREDITED.
 *    A conversion from a visitor we never recorded seeing the variant is unattributable.
 *    Counting it would let clients inflate their own numbers, and it would also break
 *    under the very common case where an exposure beacon is lost to an ad blocker.
 *    Those are reported separately instead of being quietly folded in.
 *
 * 3. EVERY RATE CARRIES AN INTERVAL AND A VERDICT.
 *    A bare conversion rate on 40 visitors is noise. We report a Wilson interval, refuse
 *    to name a winner until the intervals separate, and run a sample-ratio-mismatch
 *    check to catch broken assignment or event loss.
 */

import {
  checkSampleRatioMismatch,
  requiredSamplePerVariant,
  twoProportionPValue,
  wilsonInterval,
  type SrmResult,
} from '../core/stats.js';
import { query } from '../db/pool.js';

export interface VariantResult {
  variantKey: string;
  /** Distinct visitors with at least one exposure. */
  exposures: number;
  /** Distinct visitors with at least one exposure AND at least one conversion. */
  conversions: number;
  /** Raw event counts. Operational signal only, never used for rates. */
  rawExposureEvents: number;
  rawConversionEvents: number;
  /** Conversions attributed to a visitor who was never recorded as exposed. */
  unattributedConversions: number;
  conversionRate: number;
  /** 95% Wilson score interval. */
  confidenceInterval: { lower: number; upper: number };
  /** 95% interval, as percentages, for display. */
  confidenceIntervalPct: { lower: number; upper: number };
  /** Relative lift versus the first variant (control). Null when not the control. */
  liftVsControl: number | null;
  liftPValue: number | null;
  /** False until the confidence intervals separate from control by a real margin. */
  significant: boolean;
}

export interface ExperimentResult {
  namespace: string;
  experimentId: string;
  status: string;
  allocationBps: number;
  variants: VariantResult[];
  /** Integrity check on the observed split. */
  srm: SrmResult;
  totalExposures: number;
  totalConversions: number;
  /** The variant with the highest rate among those that reached significance. */
  leadingVariant: string | null;
  /** Human-readable guardrail on reading these numbers. */
  interpretation: string;
  /** Sample size needed per variant to detect a 20% relative lift, if known. */
  powerHint: number | null;
  generatedAt: string;
}

export interface ResultsOptions {
  namespace: string;
  experimentId: string;
  /** Only count events at or after this time. */
  since?: Date | null;
  /** Restrict to a single conversion goal. */
  goal?: string | null;
}

interface RawRow {
  variant_key: string;
  exposures: string;
  conversions: string;
  raw_exposure_events: string;
  raw_conversion_events: string;
  unattributed_conversions: string;
}

/**
 * The entire readout, in one pass.
 *
 * The first draft of this ran the counts and the attribution check as two queries, the
 * second using a NOT EXISTS correlated subquery. Postgres planned that as a
 * nested-loop anti-join, and because `variant_key` was a join filter rather than an
 * index condition, it compared every conversion against every exposure in the
 * experiment: 1,161 conversions x 13,063 exposures = 15.1M comparisons, 2.8 seconds.
 * That is O(conversions x exposures), quadratic in exactly the regime that grows
 * fastest, and it only surfaced under realistic duplicate-exposure traffic.
 *
 * Collapsing to (variant, visitor) groups first makes this a single scan plus a hash
 * aggregate, O(events). Attribution stops being a join at all: within a group, a
 * conversion whose visitor was never exposed is simply a row where `converted` is true
 * and `exposed` is false.
 */
const RESULTS_SQL = `
WITH filtered AS (
  SELECT variant_key, visitor_id, type
    FROM events
   WHERE namespace = $1
     AND experiment_id = $2
     AND ($3::timestamptz IS NULL OR ts >= $3)
     -- A goal filter must never remove exposures, or a variant would lose the
     -- denominator it needs to have a rate at all.
     AND ($4::text IS NULL OR type = 'exposure' OR goal = $4)
),
per_visitor AS (
  SELECT variant_key,
         visitor_id,
         bool_or(type = 'exposure')    AS exposed,
         bool_or(type = 'conversion') AS converted,
         count(*) FILTER (WHERE type = 'exposure')    AS raw_exposure,
         count(*) FILTER (WHERE type = 'conversion') AS raw_conversion
    FROM filtered
   GROUP BY variant_key, visitor_id
)
SELECT variant_key,
       count(*) FILTER (WHERE exposed)                    AS exposures,
       count(*) FILTER (WHERE exposed AND converted)      AS conversions,
       COALESCE(sum(raw_exposure), 0)                     AS raw_exposure_events,
       COALESCE(sum(raw_conversion), 0)                   AS raw_conversion_events,
       count(*) FILTER (WHERE converted AND NOT exposed)  AS unattributed_conversions
  FROM per_visitor
 GROUP BY variant_key
`;

export async function getExperimentResults(opts: ResultsOptions): Promise<ExperimentResult | null> {
  const { namespace, experimentId } = opts;
  const since = opts.since ?? null;
  const goal = opts.goal ?? null;

  const expRes = await query<{
    status: string;
    allocation_bps: number;
    variants: { key: string; weightBps: number }[] | null;
  }>(
    `SELECT e.status, e.allocation_bps,
            COALESCE((SELECT json_agg(json_build_object('key', v.key, 'weightBps', v.weight_bps) ORDER BY v.key)
                        FROM variants v
                       WHERE v.namespace = e.namespace AND v.experiment_id = e.id), '[]') AS variants
       FROM experiments e
      WHERE e.namespace = $1 AND e.id = $2`,
    [namespace, experimentId],
  );

  const exp = expRes.rows[0];
  if (!exp) return null;

  const evRes = await query<RawRow>(RESULTS_SQL, [
    namespace,
    experimentId,
    since?.toISOString() ?? null,
    goal,
  ]);

  const variantKeys = (exp.variants ?? []).map((v) => v.key);
  const expMap = new Map<string, number>();
  const convMap = new Map<string, number>();
  const rawExpMap = new Map<string, number>();
  const rawConvMap = new Map<string, number>();
  const orphans = new Map<string, number>();

  for (const r of evRes.rows) {
    const key = r.variant_key;
    expMap.set(key, Number(r.exposures));
    convMap.set(key, Number(r.conversions));
    rawExpMap.set(key, Number(r.raw_exposure_events));
    rawConvMap.set(key, Number(r.raw_conversion_events));
    orphans.set(key, Number(r.unattributed_conversions));
    if (!variantKeys.includes(key)) variantKeys.push(key);
  }

  // Control is the first variant by key, matching the canonical order the assignment
  // path uses, so the dashboard's control matches what the hash actually did.
  const controlKey = variantKeys[0] ?? null;
  const controlExposures = controlKey ? (expMap.get(controlKey) ?? 0) : 0;
  const controlConversions = controlKey ? (convMap.get(controlKey) ?? 0) : 0;

  const variants: VariantResult[] = variantKeys.map((key) => {
    const exposures = expMap.get(key) ?? 0;
    const conversions = convMap.get(key) ?? 0;
    const rate = exposures > 0 ? conversions / exposures : 0;
    const ci = wilsonInterval(conversions, exposures);

    const isControl = key === controlKey;
    let liftVsControl: number | null = null;
    let liftPValue: number | null = null;
    let significant = false;

    if (!isControl) {
      const controlRate = controlExposures > 0 ? controlConversions / controlExposures : 0;
      liftVsControl = controlRate > 0 ? (rate - controlRate) / controlRate : null;
      liftPValue = twoProportionPValue(controlConversions, controlExposures, conversions, exposures);
      // Significant only when the intervals actually separate. Checking the intervals
      // rather than only the p-value keeps us honest about multiple comparisons: with
      // k variants we are running k-1 tests, and a bare p < 0.05 on each would let the
      // most extreme win by chance roughly (k-1) * 5% of the time.
      const controlCi = wilsonInterval(controlConversions, controlExposures);
      significant = ci.lower > controlCi.upper || ci.upper < controlCi.lower;
    }

    return {
      variantKey: key,
      exposures,
      conversions,
      rawExposureEvents: rawExpMap.get(key) ?? 0,
      rawConversionEvents: rawConvMap.get(key) ?? 0,
      unattributedConversions: orphans.get(key) ?? 0,
      conversionRate: rate,
      confidenceInterval: ci,
      confidenceIntervalPct: { lower: ci.lower * 100, upper: ci.upper * 100 },
      liftVsControl,
      liftPValue,
      significant,
    };
  });

  // SRM is only meaningful for enrolled visitors, so the expected shares are the
  // configured variant weights, renormalised over enrolled traffic.
  const weights = (exp.variants ?? []).map((v) => v.weightBps);
  const srm = checkSampleRatioMismatch(
    variants.map((v) => v.exposures),
    weights.length ? weights : variants.map(() => 1),
  );

  const totalExposures = variants.reduce((a, v) => a + v.exposures, 0);
  const totalConversions = variants.reduce((a, v) => a + v.conversions, 0);

  const significantLeaders = variants.filter((v) => v.significant && v.variantKey !== controlKey);
  significantLeaders.sort((a, b) => b.conversionRate - a.conversionRate);
  const leadingVariant =
    significantLeaders.length > 0 && totalExposures > 0 ? (significantLeaders[0]!.variantKey) : null;

  const controlRate = controlExposures > 0 ? controlConversions / controlExposures : null;
  const powerHint =
    controlRate !== null && controlRate > 0 ? requiredSamplePerVariant(controlRate, 0.2) : null;

  return {
    namespace,
    experimentId,
    status: exp.status,
    allocationBps: exp.allocation_bps,
    variants,
    srm,
    totalExposures,
    totalConversions,
    leadingVariant,
    interpretation: interpret(variants, srm, leadingVariant, totalExposures),
    powerHint,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Turn the numbers into a sentence a human can act on.
 *
 * The point of this is that a dashboard which only shows numbers will eventually be
 * read by someone who does not know that a 40-visitor experiment means nothing. Saying
 * "not enough data" is a feature.
 */
function interpret(
  variants: VariantResult[],
  srm: SrmResult,
  leadingVariant: string | null,
  totalExposures: number,
): string {
  if (srm.mismatch) {
    return 'WARNING: observed traffic split does not match the configured split. ' +
      'Results are not trustworthy. Check assignment and event delivery before reading further.';
  }
  if (!srm.checked) {
    return `Not enough exposure (${totalExposures}) to validate the traffic split. ` +
      `Integrity check skipped: ${srm.reason}.`;
  }
  if (totalExposures === 0) {
    return 'No exposure recorded yet.';
  }
  if (leadingVariant === null) {
    if (variants.length === 0) return 'No variants configured.';
    const minI = Math.min(...variants.map((v) => v.confidenceIntervalPct.lower));
    const maxI = Math.max(...variants.map((v) => v.confidenceIntervalPct.upper));
    return `No variant is beating control yet. Confidence intervals overlap ` +
      `(${minI.toFixed(2)}% to ${maxI.toFixed(2)}%). Keep running.`;
  }
  return `${leadingVariant} is currently leading with a confidence interval clear of control. ` +
    `Confirm the sample size meets your target before shipping.`;
}
