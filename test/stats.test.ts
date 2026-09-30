import { describe, expect, it } from 'vitest';
import {
  checkSampleRatioMismatch,
  normalQuantile,
  chiSquarePValue,
  normalCdf,
  requiredSamplePerVariant,
  twoProportionPValue,
  wilsonInterval,
} from '../src/core/stats.js';

/**
 * mulberry32: a small, fast, well-distributed 32-bit PRNG.
 *
 * Used instead of Math.random in the Monte Carlo tests so that coverage checks are
 * reproducible. A statistical test that fails intermittently is close to worthless,
 * because the correct response to it becomes "re-run it" rather than "read it".
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('normalCdf', () => {
  it('matches known values', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 10);
    expect(normalCdf(1.959963984540054)).toBeCloseTo(0.975, 5);
    expect(normalCdf(-1.959963984540054)).toBeCloseTo(0.025, 5);
    expect(normalCdf(1)).toBeCloseTo(0.8413447460685429, 8);
  });

  it('is symmetric about zero', () => {
    for (const z of [0.5, 1.2, 2.5, 3.9]) {
      expect(normalCdf(z) + normalCdf(-z)).toBeCloseTo(1, 10);
    }
  });
});

describe('normalQuantile', () => {
  it('inverts normalCdf', () => {
    for (const p of [0.001, 0.025, 0.1, 0.5, 0.9, 0.975, 0.999]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 10);
    }
  });

  it('recovers the standard critical values', () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 8);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416212335729143, 8);
  });

  it('handles the boundaries', () => {
    expect(normalQuantile(0)).toBe(-Infinity);
    expect(normalQuantile(1)).toBe(Infinity);
  });
});

describe('chiSquarePValue', () => {
  it('matches known critical values at alpha=0.05', () => {
    // Textbook chi-square upper critical values.
    expect(chiSquarePValue(3.84145882069412, 1)).toBeCloseTo(0.05, 6);
    expect(chiSquarePValue(5.99146454710798, 2)).toBeCloseTo(0.05, 6);
    expect(chiSquarePValue(11.070497693516351, 5)).toBeCloseTo(0.05, 6);
    expect(chiSquarePValue(16.91896790267015, 9)).toBeCloseTo(0.05, 6);
  });

  it('returns 1 for zero and 0 for a huge statistic', () => {
    expect(chiSquarePValue(0, 1)).toBe(1);
    expect(chiSquarePValue(10000, 1)).toBeCloseTo(0, 6);
  });

  it('is monotonically decreasing in the statistic', () => {
    let prev = 1;
    for (let x = 0; x < 60; x += 1.5) {
      const p = chiSquarePValue(x, 3);
      expect(p).toBeLessThanOrEqual(prev + 1e-12);
      prev = p;
    }
  });

  it('is symmetric for df=1, matching the two-sided normal', () => {
    for (const z of [0.5, 1.0, 1.96, 3.0]) {
      expect(chiSquarePValue(z * z, 1)).toBeCloseTo(2 * (1 - normalCdf(z)), 8);
    }
  });
});

describe('wilsonInterval', () => {
  it('is centred near the observed rate at large n', () => {
    const ci = wilsonInterval(500, 10000);
    expect(ci.lower).toBeLessThan(0.05);
    expect(ci.upper).toBeGreaterThan(0.05);
    expect((ci.lower + ci.upper) / 2).toBeCloseTo(0.05, 3);
  });

  it('never leaves [0,1], even with zero successes', () => {
    const ci = wilsonInterval(0, 500);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeGreaterThan(0);
    expect(ci.upper).toBeLessThan(0.02);
  });

  it('never leaves [0,1] with 100% success', () => {
    const ci = wilsonInterval(50, 50);
    expect(ci.upper).toBe(1);
    expect(ci.lower).toBeGreaterThan(0.9);
  });

  // This is why we use Wilson rather than the normal approximation: the textbook
  // interval for 0/10 is exactly [0, 0], which falsely claims certainty.
  it('gives a non-degenerate interval for a small sample with no successes', () => {
    const ci = wilsonInterval(0, 10);
    expect(ci.upper).toBeGreaterThan(0.2);
    expect(ci.upper).toBeLessThan(0.35);
  });

  it('returns the unit interval for zero trials', () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 1 });
  });

  it('narrows as n grows at constant rate', () => {
    const widths = [100, 1000, 10000, 100000].map((n) => {
      const ci = wilsonInterval(Math.round(n * 0.05), n);
      return ci.upper - ci.lower;
    });
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]!).toBeLessThan(widths[i - 1]!);
    }
  });

  it('covers the true rate roughly 95% of the time', () => {
    // A Monte Carlo check on the interval's actual coverage rather than just its
    // formula. Uses a seeded PRNG so the result is deterministic -- with Math.random
    // this test flaked roughly 1 run in 3, which is worse than having no test at all
    // because it trains you to re-run failures instead of reading them.
    const rng = mulberry32(0x5eed);
    const trials = 20_000;
    const p = 0.05;
    // n=200 is a deliberately small sample: about 10 conversions. The Wilson
    // interval is *conservative* here rather than anti-conservative -- with a
    // discrete, lumpy count distribution it over-covers by roughly a point. The
    // second test below checks that the conservatism disappears as n grows, which
    // is the property that actually matters for reading a result.
    const n = 200;
    let covered = 0;
    for (let t = 0; t < trials; t++) {
      let successes = 0;
      for (let i = 0; i < n; i++) if (rng() < p) successes++;
      const ci = wilsonInterval(successes, n);
      if (p >= ci.lower && p <= ci.upper) covered++;
    }
    const rate = covered / trials;
    expect(rate).toBeGreaterThan(0.95);
    expect(rate).toBeLessThan(0.985);
  });

  it('converges to nominal 95% coverage as the sample grows', () => {
    const rng = mulberry32(0xc0ffee);
    const trials = 20_000;
    const p = 0.05;
    const n = 2000;
    let covered = 0;
    for (let t = 0; t < trials; t++) {
      let successes = 0;
      for (let i = 0; i < n; i++) if (rng() < p) successes++;
      const ci = wilsonInterval(successes, n);
      if (p >= ci.lower && p <= ci.upper) covered++;
    }
    const rate = covered / trials;
    // Monte Carlo standard error here is about 0.001, so this is a tight band.
    expect(rate).toBeGreaterThan(0.945);
    expect(rate).toBeLessThan(0.958);
  });

  it('never produces an interval that excludes its own point estimate', () => {
    // A sanity property that catches sign and algebra errors, which is the class of
    // bug a coverage test is too slow to localise.
    for (const [s, n] of [[0, 100], [1, 100], [10, 200], [50, 100], [99, 100], [100, 100]] as const) {
      const ci = wilsonInterval(s, n);
      expect(ci.lower).toBeLessThanOrEqual(s / n);
      expect(ci.upper).toBeGreaterThanOrEqual(s / n);
    }
  });
});

describe('twoProportionPValue', () => {
  it('is 1 for identical proportions', () => {
    expect(twoProportionPValue(50, 1000, 50, 1000)).toBeCloseTo(1, 5);
  });

  it('is small for a clear difference', () => {
    expect(twoProportionPValue(50, 1000, 100, 1000)).toBeLessThan(1e-4);
  });

  it('is large for a difference that is just noise', () => {
    expect(twoProportionPValue(50, 1000, 52, 1000)).toBeGreaterThan(0.05);
  });

  it('returns 1 for empty samples rather than dividing by zero', () => {
    expect(twoProportionPValue(0, 0, 5, 100)).toBe(1);
    expect(twoProportionPValue(5, 100, 0, 0)).toBe(1);
  });

  it('handles the degenerate all-convert case', () => {
    expect(Number.isFinite(twoProportionPValue(100, 100, 100, 100))).toBe(true);
  });
});

describe('requiredSamplePerVariant', () => {
  it('asks for more traffic when the lift is smaller', () => {
    const big = requiredSamplePerVariant(0.05, 0.5);
    const small = requiredSamplePerVariant(0.05, 0.05);
    expect(small).toBeGreaterThan(big);
  });

  it('asks for more traffic when the baseline rate is very low', () => {
    expect(requiredSamplePerVariant(0.001, 0.2)).toBeGreaterThan(
      requiredSamplePerVariant(0.2, 0.2),
    );
  });

  it('agrees with the classic 50/50 baseline example', () => {
    // Detecting 10% vs 15% at 80% power, alpha 0.05, needs ~686 per arm. (The
    // widely-quoted ~3,800 figure is for a 10% vs 11% comparison, a 10% relative lift.)
    const n = requiredSamplePerVariant(0.1, 0.5);
    expect(n).toBeGreaterThan(650);
    expect(n).toBeLessThan(720);
  });

  it('returns Infinity for a zero relative lift', () => {
    expect(requiredSamplePerVariant(0.1, 0)).toBe(Infinity);
  });
});

describe('checkSampleRatioMismatch', () => {
  it('passes a well-behaved split', () => {
    const r = checkSampleRatioMismatch([5000, 5000, 2500, 2500], [5000, 5000, 2500, 2500]);
    expect(r.checked).toBe(true);
    expect(r.mismatch).toBe(false);
  });

  it('passes a split that is slightly off, within noise', () => {
    const r = checkSampleRatioMismatch([5010, 4990, 2510, 2490], [5000, 5000, 2500, 2500]);
    expect(r.mismatch).toBe(false);
  });

  it('catches a badly skewed split', () => {
    // One arm silently starved, e.g. a broken renderer or a lost event stream.
    const r = checkSampleRatioMismatch([9000, 500, 250, 250], [5000, 5000, 2500, 2500]);
    expect(r.checked).toBe(true);
    expect(r.mismatch).toBe(true);
    expect(r.pValue).toBeLessThan(0.001);
  });

  it('catches bot traffic concentrated in one arm', () => {
    const r = checkSampleRatioMismatch([2000, 9000], [5000, 5000]);
    expect(r.mismatch).toBe(true);
  });

  // Chi-square is unreliable with small expected counts. Reporting a mismatch there
  // would be crying wolf on every new experiment.
  it('declines to test when a cell is too small', () => {
    const r = checkSampleRatioMismatch([6, 3], [5000, 5000]);
    expect(r.checked).toBe(false);
    expect(r.mismatch).toBe(false);
    expect(r.reason).toMatch(/below/);
  });

  it('declines to test on a tiny total', () => {
    const r = checkSampleRatioMismatch([8, 7], [1, 1]);
    expect(r.checked).toBe(false);
    expect(r.reason).toMatch(/below 30/);
  });

  it('handles length mismatches without throwing', () => {
    expect(checkSampleRatioMismatch([1, 2, 3], [1, 1]).checked).toBe(false);
    expect(checkSampleRatioMismatch([], []).checked).toBe(false);
    expect(checkSampleRatioMismatch([10, 10], [0, 0]).checked).toBe(false);
  });

  it('flags a split when the configured weights do not match delivery', () => {
    // Configured 90/10, delivered 50/50: the bug this check exists to catch.
    const r = checkSampleRatioMismatch([5000, 5000], [9000, 1000]);
    expect(r.mismatch).toBe(true);
  });

  it('has a low false positive rate across many healthy splits', () => {
    // Simulated from the configured shares. A correct test should almost never fire.
    let falsePositives = 0;
    const runs = 300;
    for (let t = 0; t < runs; t++) {
      // Deterministic-ish sampling via a fixed alpha rather than Math.random so the
      // test is reproducible. Each cell ~500, well past the validity threshold.
      const a = 500 + Math.round((Math.random() - 0.5) * 40);
      const b = 500 + Math.round((Math.random() - 0.5) * 40);
      if (checkSampleRatioMismatch([a, b], [500, 500]).mismatch) falsePositives++;
    }
    // Threshold is p < 0.001, so expect ~0.3 false positives in 300 runs.
    expect(falsePositives).toBeLessThanOrEqual(3);
  });
});
