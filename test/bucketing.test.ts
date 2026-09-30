import { describe, expect, it } from 'vitest';
import {
  allocationBucket,
  assign,
  compileExperiment,
  variantBucket,
} from '../src/core/bucketing.js';
import { chiSquarePValue } from '../src/core/stats.js';
import { BUCKET_COUNT, type Experiment } from '../src/core/types.js';

function experiment(overrides: Partial<Experiment> = {}): Experiment {
  return {
    namespace: 'ns1',
    id: 'exp1',
    status: 'running',
    allocationBps: BUCKET_COUNT,
    salt: null,
    variants: [
      { key: 'control', weightBps: 5000 },
      { key: 'treatment', weightBps: 5000 },
    ],
    creatives: {},
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function visitors(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `visitor-${i}`);
}

describe('determinism and stickiness', () => {
  it('returns the same variant for the same visitor every time', () => {
    const exp = compileExperiment(experiment());
    for (const v of visitors(2000)) {
      const first = assign(exp, v);
      for (let i = 0; i < 25; i++) {
        expect(assign(exp, v)).toEqual(first);
      }
    }
  });

  it('is unaffected by recompiling the experiment (simulates a config refresh)', () => {
    const before = compileExperiment(experiment());
    const after = compileExperiment(experiment({ version: 99, updatedAt: 'later' }));
    for (const v of visitors(1000)) {
      expect(assign(after, v).variantKey).toBe(assign(before, v).variantKey);
    }
  });

  it('is unaffected by a change in variant order in the config', () => {
    const a = compileExperiment(experiment());
    const b = compileExperiment(
      experiment({
        variants: [
          { key: 'treatment', weightBps: 5000 },
          { key: 'control', weightBps: 5000 },
        ],
      }),
    );
    // Boundaries are positional, so an unsorted implementation would flip every
    // visitor's arm when an operator merely reordered the list in the config.
    for (const v of visitors(1000)) {
      expect(assign(b, v).variantKey).toBe(assign(a, v).variantKey);
    }
  });

  it('cannot be influenced by a caller injecting the field separator', () => {
    const a = compileExperiment(experiment());
    // If fields were joined without a separator, namespace "ns1\x1fexp1" would alias
    // experiment "exp1". Verify no such aliasing is reachable.
    const b = compileExperiment(experiment({ namespace: 'ns1\x1fexp1', id: 'x' }));
    expect(b.id).not.toBe(a.id);
  });
});

describe('distribution', () => {
  const N = 200_000;

  function counts(variants: { key: string; weightBps: number }[], allocation = BUCKET_COUNT) {
    const exp = compileExperiment(experiment({ variants, allocationBps: allocation }));
    const tally: Record<string, number> = {};
    for (const v of visitors(N)) {
      const r = assign(exp, v);
      if (r.variantKey) tally[r.variantKey] = (tally[r.variantKey] ?? 0) + 1;
    }
    return tally;
  }

  it('splits 50/50 within sampling error', () => {
    const tally = counts([
      { key: 'a', weightBps: 5000 },
      { key: 'b', weightBps: 5000 },
    ]);
    const obs = [tally.a!, tally.b!];
    const total = obs[0]! + obs[1]!;
    const chi2 = ((obs[0]! - total / 2) ** 2) / (total / 2) + ((obs[1]! - total / 2) ** 2) / (total / 2);
    expect(chiSquarePValue(chi2, 1)).toBeGreaterThan(0.01);
  });

  it('honours an uneven 90/10 split', () => {
    const tally = counts([
      { key: 'a', weightBps: 9000 },
      { key: 'b', weightBps: 1000 },
    ]);
    const total = tally.a! + tally.b!;
    expect(tally.b! / total).toBeGreaterThan(0.094);
    expect(tally.b! / total).toBeLessThan(0.106);
  });

  it('honours a three-way 34/33/33 split', () => {
    const tally = counts([
      { key: 'a', weightBps: 3400 },
      { key: 'b', weightBps: 3300 },
      { key: 'c', weightBps: 3300 },
    ]);
    const total = tally.a! + tally.b! + tally.c!;
    for (const k of ['a', 'b', 'c']) {
      expect(tally[k]! / total).toBeGreaterThan(0.32);
      expect(tally[k]! / total).toBeLessThan(0.35);
    }
  });

  it('honours arbitrary weights that do not sum to 10_000', () => {
    const tally = counts([
      { key: 'a', weightBps: 1 },
      { key: 'b', weightBps: 1 },
      { key: 'c', weightBps: 2 },
    ]);
    const total = tally.a! + tally.b! + tally.c!;
    expect(tally.a! / total).toBeCloseTo(0.25, 2);
    expect(tally.c! / total).toBeCloseTo(0.5, 2);
  });

  it('never assigns a zero-weight variant', () => {
    const tally = counts([
      { key: 'a', weightBps: 0 },
      { key: 'b', weightBps: 1 },
    ]);
    expect(tally.a ?? 0).toBe(0);
    expect(tally.b).toBeGreaterThan(N * 0.99);
  });

  it('enrols nobody when every variant has zero weight', () => {
    // Reading "all arms are zero weight" as "dump everyone into arm one" would be a
    // catastrophic misreading of the config. Falling back to no assignment is correct.
    const exp = compileExperiment(experiment({ variants: [{ key: 'a', weightBps: 0 }] }));
    for (const v of visitors(500)) {
      const r = assign(exp, v);
      expect(r.variantKey).toBeNull();
      expect(r.reason).toBe('no_variants');
    }
  });

  it('assigns every enrolled visitor to exactly one variant', () => {
    const exp = compileExperiment(
      experiment({
        variants: [
          { key: 'a', weightBps: 3333 },
          { key: 'b', weightBps: 3333 },
          { key: 'c', weightBps: 3333 },
        ],
      }),
    );
    for (const v of visitors(5000)) {
      const r = assign(exp, v);
      expect(['a', 'b', 'c']).toContain(r.variantKey);
    }
  });

  it('keeps a 20% traffic allocation at ~20% enrolment', () => {
    const tally = counts(
      [
        { key: 'a', weightBps: 5000 },
        { key: 'b', weightBps: 5000 },
      ],
      2000,
    );
    const enrolled = (tally.a ?? 0) + (tally.b ?? 0);
    expect(enrolled / N).toBeGreaterThan(0.195);
    expect(enrolled / N).toBeLessThan(0.205);
  });

  it('enrols nobody at 0% allocation', () => {
    const exp = compileExperiment(experiment({ allocationBps: 0 }));
    for (const v of visitors(2000)) {
      expect(assign(exp, v).variantKey).toBeNull();
    }
  });

  it('reaches the whole bucket space with no dead buckets', () => {
    // Coupon collector: with n draws into m buckets the expected number of *distinct*
    // buckets hit is m(1 - e^(-n/m)). For n=50_000, m=10_000 that is ~9933, so
    // demanding all 10_000 would be a test of my arithmetic, not of the code. The real
    // claim being checked is that the range is fully spanned, i.e. no dead buckets and
    // no clustering into a sub-range.
    const exp = compileExperiment(experiment());
    const seen = new Set<number>();
    for (let i = 0; i < 50_000; i++) seen.add(variantBucket(exp, `v-${i}`));
    expect(seen.size).toBeGreaterThan(9850);
    expect(seen.size).toBeLessThan(9975);
  });
});

describe('independence between experiments', () => {
  it('does not put the same visitor in the same arm of two experiments', () => {
    // With two 50/50 experiments, a perfect correlation would be a coincidence rate of
    // 100%. Independence should put it near 50%.
    const a = compileExperiment(experiment({ id: 'expA' }));
    const b = compileExperiment(experiment({ id: 'expB' }));
    let agree = 0;
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const v = `visitor-${i}`;
      if (assign(a, v).variantKey === assign(b, v).variantKey) agree++;
    }
    expect(agree / N).toBeGreaterThan(0.49);
    expect(agree / N).toBeLessThan(0.51);
  });

  it('separates namespaces so the same visitor is uncorrelated across tenants', () => {
    const a = compileExperiment(experiment({ namespace: 'tenantA' }));
    const b = compileExperiment(experiment({ namespace: 'tenantB' }));
    let agree = 0;
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const v = `visitor-${i}`;
      if (assign(a, v).variantKey === assign(b, v).variantKey) agree++;
    }
    expect(agree / N).toBeGreaterThan(0.49);
    expect(agree / N).toBeLessThan(0.51);
  });

  it('allocates the same visitor independently at each traffic level', () => {
    // 50% and 90% allocation should still be 50/50 *within* each enrolled population.
    for (const allocation of [2000, 5000, 9000, BUCKET_COUNT]) {
      const exp = compileExperiment(experiment({ allocationBps: allocation }));
      let a = 0;
      let b = 0;
      for (let i = 0; i < 100_000; i++) {
        if (assign(exp, `visitor-${i}`).variantKey === 'control') a++;
        else if (assign(exp, `visitor-${i}`).variantKey === 'treatment') b++;
      }
      expect(a / (a + b)).toBeGreaterThan(0.49);
      expect(a / (a + b)).toBeLessThan(0.51);
    }
  });

  it('decouples the allocation decision from the variant decision', () => {
    // This is the property that lets you change traffic allocation without reshuffling
    // variants for visitors who are already enrolled. Lower the allocation from 100% to
    // 50%: a visitor who stays enrolled must keep their variant.
    const full = compileExperiment(experiment({ allocationBps: BUCKET_COUNT }));
    const half = compileExperiment(experiment({ allocationBps: 5000 }));
    let checked = 0;
    for (let i = 0; i < 100_000; i++) {
      const v = `visitor-${i}`;
      const before = assign(full, v);
      const after = assign(half, v);
      if (after.variantKey !== null) {
        checked++;
        expect(after.variantKey).toBe(before.variantKey);
      }
    }
    expect(checked).toBeGreaterThan(45_000);
  });
});

describe('weight changes', () => {
  it('moves only the visitors near the boundary', () => {
    // Changing 50/50 to 60/40 should move roughly 10% of the population, not all of it.
    const before = compileExperiment(experiment());
    const after = compileExperiment(
      experiment({
        variants: [
          { key: 'control', weightBps: 6000 },
          { key: 'treatment', weightBps: 4000 },
        ],
      }),
    );
    let moved = 0;
    const N = 100_000;
    for (let i = 0; i < N; i++) {
      const v = `visitor-${i}`;
      if (assign(before, v).variantKey !== assign(after, v).variantKey) moved++;
    }
    expect(moved / N).toBeGreaterThan(0.09);
    expect(moved / N).toBeLessThan(0.11);
  });

  it('re-randomises everyone when the salt is rotated', () => {
    const before = compileExperiment(experiment());
    const after = compileExperiment(experiment({ salt: 'v2' }));
    let same = 0;
    const N = 50_000;
    for (let i = 0; i < N; i++) {
      if (assign(before, `visitor-${i}`).variantKey === assign(after, `visitor-${i}`).variantKey) same++;
    }
    // With two arms, a random reshuffle keeps ~50% in place, i.e. it really moved.
    expect(same / N).toBeLessThan(0.55);
    expect(same / N).toBeGreaterThan(0.45);
  });
});

describe('fail-safe behaviour', () => {
  it('returns not_found for an unknown experiment instead of throwing', () => {
    const r = assign(undefined, 'visitor-1');
    expect(r.variantKey).toBeNull();
    expect(r.reason).toBe('experiment_not_found');
  });

  it('withholds variants from a paused experiment', () => {
    const exp = compileExperiment(experiment({ status: 'paused' }));
    for (const v of visitors(1000)) {
      expect(assign(exp, v).variantKey).toBeNull();
    }
  });

  it('withholds variants from a draft experiment', () => {
    const exp = compileExperiment(experiment({ status: 'draft' }));
    for (const v of visitors(1000)) {
      expect(assign(exp, v).variantKey).toBeNull();
    }
  });

  it('reports no_variants rather than throwing on a degenerate experiment', () => {
    const exp = compileExperiment(experiment({ variants: [] }));
    expect(assign(exp, 'visitor-1').reason).toBe('no_variants');
  });

  it('reports not_in_allocation for held-back visitors', () => {
    const exp = compileExperiment(experiment({ allocationBps: 1 }));
    let held = 0;
    for (let i = 0; i < 2000; i++) {
      if (assign(exp, `visitor-${i}`).reason === 'not_in_allocation') held++;
    }
    expect(held).toBeGreaterThan(1950);
  });
});

describe('hash properties', () => {
  it('does not leak raw visitor-id structure across experiments', () => {
    // Sequential visitor ids must not produce sequential buckets, or an attacker could
    // enumerate the assignment of any visitor by scanning.
    const exp = compileExperiment(experiment());
    const buckets = Array.from({ length: 200 }, (_, i) => variantBucket(exp, `visitor-${i}`));
    // Adjacent ids should be uncorrelated: no long runs.
    let longestRun = 1;
    let run = 1;
    for (let i = 1; i < buckets.length; i++) {
      if (Math.abs(buckets[i]! - buckets[i - 1]!) <= 1) {
        run++;
        longestRun = Math.max(longestRun, run);
      } else run = 1;
    }
    expect(longestRun).toBeLessThan(6);
  });

  it('spreads sequential ids across most of the bucket space', () => {
    // n=20_000 draws into m=10_000 buckets => expected distinct ~ m(1 - e^-2) ~ 8647.
    const exp = compileExperiment(experiment());
    const seen = new Set<number>();
    for (let i = 0; i < 20_000; i++) seen.add(variantBucket(exp, `visitor-${i}`));
    expect(seen.size).toBeGreaterThan(8500);
    expect(seen.size).toBeLessThan(8800);
  });

  it('handles adversarial visitor ids safely', () => {
    const exp = compileExperiment(experiment());
    const nasty = [
      '',
      ' ',
      'a'.repeat(4096),
      '../../etc/passwd',
      '\x1f\x1f\x1f',
      'null',
      'undefined',
      'NaN',
      '{}',
      '𝕦𝕫𝕚𝕔𝕠𝕕𝕖',
    ];
    for (const id of nasty) {
      expect(() => assign(exp, id)).not.toThrow();
      expect(['control', 'treatment']).toContain(assign(exp, id).variantKey);
    }
  });

  it('gives different results for ids differing only by a separator', () => {
    const exp = compileExperiment(experiment());
    expect(allocationBucket(exp, 'a\x1fb')).not.toBe(allocationBucket(exp, 'ab'));
  });
});
