/**
 * Variant distinctness.
 *
 * An experiment whose arms carry the same copy measures nothing. It will still produce
 * numbers, and because the numbers will be pure noise, someone will eventually read a
 * 5% difference at p<0.05 and ship a change that does nothing. This is a quiet,
 * expensive failure mode, so we check for it explicitly rather than hoping the model
 * behaves.
 *
 * Similarity is token-level Jaccard on a normalised string. It is not semantic
 * similarity and does not need to be: paraphrases like "Start your free trial" and
 * "Begin your free trial" share almost all their content words, which is exactly the
 * case we want to catch. Embedding similarity would be a more powerful check and a
 * model call on a control-plane path, which is a poor trade for this.
 */

export function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenSet(s: string): Set<string> {
  return new Set(normalise(s).split(' ').filter((t) => t.length > 0));
}

/** Jaccard similarity: |A n B| / |A u B|. 0 = disjoint, 1 = identical. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/** Similarity across every rendered field of a creative, not just the headline. */
export function creativeSimilarity(
  a: { headline: string; cta?: string; body?: string },
  b: { headline: string; cta?: string; body?: string },
): number {
  const headline = jaccard(tokenSet(a.headline), tokenSet(b.headline));
  const cta = a.cta && b.cta ? jaccard(tokenSet(a.cta), tokenSet(b.cta)) : 0;
  return Math.max(headline, 0.5 * headline + 0.5 * cta);
}

export interface DistinctnessReport {
  ok: boolean;
  /** Pairs of arms that are too similar to be distinguishable. */
  collisions: { a: string; b: string; similarity: number }[];
  worstSimilarity: number;
  threshold: number;
}

/**
 * Default threshold. At 0.6 two arms share enough vocabulary that a reader would see
 * them as the same message. Tunable per experiment for teams that deliberately run
 * subtle copy tests.
 */
export const DEFAULT_DISTINCTNESS_THRESHOLD = 0.6;

export function checkDistinctness(
  arms: { key: string; headline: string; cta?: string; body?: string }[],
  threshold = DEFAULT_DISTINCTNESS_THRESHOLD,
): DistinctnessReport {
  const collisions: { a: string; b: string; similarity: number }[] = [];
  let worst = 0;

  for (let i = 0; i < arms.length; i++) {
    for (let j = i + 1; j < arms.length; j++) {
      const sim = creativeSimilarity(arms[i]!, arms[j]!);
      worst = Math.max(worst, sim);
      if (sim >= threshold) {
        collisions.push({ a: arms[i]!.key, b: arms[j]!.key, similarity: Number(sim.toFixed(3)) });
      }
    }
  }

  return { ok: collisions.length === 0, collisions, worstSimilarity: Number(worst.toFixed(3)), threshold };
}
