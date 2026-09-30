/**
 * Statistics for experiment readout.
 *
 * The rule this file exists to enforce: never report a bare conversion rate. A bare
 * rate on 12 visitors is noise, and a dashboard that shows it will get a customer to
 * ship a change that makes things worse. Everything here exists so the API can say
 * "we do not know yet" honestly.
 */

// ---------------------------------------------------------------------------
// Normal distribution
// ---------------------------------------------------------------------------

/**
 * Standard normal CDF.
 *
 * Implemented through the regularised upper incomplete gamma rather than an erf
 * approximation. The identity erfc(x) = Q(1/2, x^2) lets us reuse the gamma machinery
 * below, which carries full double precision. The usual Abramowitz-Stegun erf
 * approximation is only good to ~1.5e-7 absolute, which is fine for a p-value but
 * visibly wrong when someone asserts against a known critical value.
 */
export function normalCdf(z: number): number {
  const t = (z * z) / 2;
  return z >= 0 ? 1 - 0.5 * gammaQ(0.5, t) : 0.5 * gammaQ(0.5, t);
}

/** Two-sided p-value for a two-proportion z-test. */
export function twoProportionPValue(
  convA: number,
  nA: number,
  convB: number,
  nB: number,
): number {
  if (nA === 0 || nB === 0) return 1;
  const p1 = convA / nA;
  const p2 = convB / nB;
  const pooled = (convA + convB) / (nA + nB);
  if (pooled === 0 || pooled === 1) return 1;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / nA + 1 / nB));
  if (se === 0) return 1;
  const z = (p2 - p1) / se;
  return 2 * (1 - normalCdf(Math.abs(z)));
}

// ---------------------------------------------------------------------------
// Wilson score interval
// ---------------------------------------------------------------------------

export interface Interval {
  lower: number;
  upper: number;
}

/**
 * Wilson score interval for a binomial proportion.
 *
 * We use this rather than the textbook normal approximation because the normal
 * approximation is only valid for large n and p away from the edges. It is exactly
 * wrong in the regime experiments live in: small samples, and conversion rates in the
 * 0.1%-5% range. Wilson stays well-behaved at n=10 and at p=0.001, and it never
 * produces an interval that extends outside [0, 1].
 */
export function wilsonInterval(successes: number, trials: number, z = 1.959963984540054): Interval {
  if (trials <= 0) return { lower: 0, upper: 1 };

  // Exactly zero successes has an exactly zero lower bound. Returning the raw
  // expression here yields ~4e-19 from floating-point cancellation, which is noise
  // leaking into an API response.
  if (successes <= 0) {
    const z2 = z * z;
    const upper = z2 / (trials + z2);
    return { lower: 0, upper: Math.min(1, upper) };
  }
  if (successes >= trials) {
    const z2 = z * z;
    const lower = trials / (trials + z2);
    return { lower: Math.max(0, lower), upper: 1 };
  }

  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return {
    lower: Math.max(0, (centre - margin) / denom),
    upper: Math.min(1, (centre + margin) / denom),
  };
}

/**
 * Sample size needed per variant to detect a relative lift, at 80% power and alpha 0.05.
 *
 * n = (z_a * sqrt(2 * pbar * (1 - pbar)) + z_b * sqrt(p1 q1 + p2 q2))^2 / (p2 - p1)^2
 *
 * Note the parentheses. It is the square of a *sum*, not a sum of squares. Getting that
 * wrong is easy, and it quietly understates the required sample by around 40% -- which
 * would tell a customer they need 400 visitors per arm when they need 700, and they
 * would ship a decision based on noise.
 */
export function requiredSamplePerVariant(
  baselineRate: number,
  relativeLift: number,
  power = 0.8,
  alpha = 0.05,
): number {
  const p1 = baselineRate;
  const p2 = baselineRate * (1 + relativeLift);
  if (p2 === p1) return Infinity;
  if (p1 <= 0 || p1 >= 1) return Infinity;

  const zAlpha = normalQuantile(1 - alpha / 2);
  // Two-sided power, expressed as a z. Approximated from the standard normal CDF.
  const zBeta = normalQuantile(power);

  const pBar = (p1 + p2) / 2;
  const a = zAlpha * Math.sqrt(2 * pBar * (1 - pBar));
  const b = zBeta * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  const delta = p2 - p1;

  return Math.ceil(Math.pow(a + b, 2) / (delta * delta));
}

/**
 * Inverse standard normal CDF, by bisection on normalCdf.
 *
 * Bisection rather than a rational approximation: it reuses normalCdf, so there is only
 * one piece of numerical code to get right, and this is called a handful of times per
 * results request, not on a hot path. 60 iterations drives the interval below 1e-16,
 * which is far past anything meaningful for a z-score.
 */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  let lo = -40;
  let hi = 40;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Chi-square, for the sample-ratio-mismatch check
// ---------------------------------------------------------------------------

/** Lanczos approximation, g=7, n=9. Accurate to ~1e-13 for our range. */
function lnGamma(x: number): number {
  const g = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  const z = x - 1;
  let a = g[0]!;
  const t = z + 7.5;
  for (let i = 1; i < g.length; i++) a += g[i]! / (z + i);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Regularised upper incomplete gamma Q(a, x), continued-fraction method. */
function gammaQ(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 1;
  if (x < a + 1) {
    // Series for P(a,x), then Q = 1 - P
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 500; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-15) break;
    }
    const p = sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
    return 1 - p;
  }
  // Continued fraction for Q(a,x)
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

/** Upper-tail p-value for a chi-square statistic with `df` degrees of freedom. */
export function chiSquarePValue(chi2: number, df: number): number {
  if (df <= 0) return 1;
  if (chi2 <= 0) return 1;
  return Math.max(0, Math.min(1, gammaQ(df / 2, chi2 / 2)));
}

// ---------------------------------------------------------------------------
// Sample ratio mismatch
// ---------------------------------------------------------------------------

export interface SrmResult {
  /** Chi-square goodness-of-fit statistic against the configured split. */
  chiSquare: number;
  degreesOfFreedom: number;
  pValue: number;
  /**
   * False when we deliberately refuse to test. Chi-square is unreliable with small
   * expected counts, and a test that fires on noise is worse than no test.
   */
  checked: boolean;
  /** True only when we tested and found a real mismatch. */
  mismatch: boolean;
  reason: string;
}

/**
 * Detect a sample ratio mismatch: did we actually get the traffic split we configured?
 *
 * A mismatch is the single most important integrity check in an experimentation system.
 * It catches broken assignment, broken event delivery, bot traffic in one arm, and
 * outages that silently kill one variant. It is cheap and it catches whole classes of
 * bugs that conversion rates alone will not reveal.
 *
 * We gate on expected count >= MIN_EXPECTED_PER_CELL. Below that, the chi-square
 * approximation is invalid and we report "not checked" rather than guessing.
 */
export function checkSampleRatioMismatch(
  observed: number[],
  expectedShares: number[],
  minExpectedPerCell = 5,
): SrmResult {
  const n = observed.length;
  const total = observed.reduce((a, b) => a + b, 0);
  const shareTotal = expectedShares.reduce((a, b) => a + b, 0);

  const base: SrmResult = {
    chiSquare: 0,
    degreesOfFreedom: 0,
    pValue: 1,
    checked: false,
    mismatch: false,
    reason: '',
  };

  if (n === 0 || shareTotal <= 0) {
    return { ...base, reason: 'no expected shares supplied' };
  }
  if (n !== expectedShares.length) {
    return { ...base, reason: 'observed and expected lengths differ' };
  }

  const expected = expectedShares.map((s) => (s / shareTotal) * total);
  const smallest = Math.min(...expected);

  if (total < 30) {
    return { ...base, reason: `total exposure ${total} below 30, too small to test` };
  }
  if (smallest < minExpectedPerCell) {
    return {
      ...base,
      reason: `smallest expected cell ${smallest.toFixed(1)} below ${minExpectedPerCell}, chi-square not valid`,
    };
  }

  let chi2 = 0;
  for (let i = 0; i < n; i++) {
    const e = expected[i]!;
    const d = observed[i]! - e;
    chi2 += (d * d) / e;
  }

  const df = n - 1;
  const pValue = chiSquarePValue(chi2, df);

  return {
    chiSquare: chi2,
    degreesOfFreedom: df,
    pValue,
    checked: true,
    mismatch: pValue < 0.001,
    reason: pValue < 0.001 ? 'observed split differs from configured split' : 'consistent with configured split',
  };
}
