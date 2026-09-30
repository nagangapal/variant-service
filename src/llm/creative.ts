/**
 * Creative generation.
 *
 * ============================ THE CENTRAL DECISION ============================
 *
 * There is no LLM call on the assignment path. Not a fast one, not a cached one, not a
 * speculative one. Assignment returns a string that was written to the database before
 * the first visitor ever saw the experiment. The reasoning, in the order that actually
 * decided it:
 *
 * 1. LATENCY. The assignment endpoint has a ~150ms budget end to end, most of which is
 *    network. A hosted LLM call is 500ms-3s at p50 and has a long, fat tail. Putting
 *    one on this path means the customer's page waits on our vendor's worst case. No
 *    amount of caching fixes that, because the cache has to be cold exactly when the
 *    traffic is highest.
 *
 * 2. COST. One LLM call per page view is the difference between ~$0.02 and ~$20,000 per
 *    experiment per month at a million monthly page views. Pre-generating K candidates
 *    for a handful of variants costs cents, once. The multiplier is roughly 10^6.
 *
 * 3. DETERMINISM. The brief requires assignment to be deterministic and sticky. If the
 *    copy is generated per request, the same visitor can see different text on two
 *    page loads, and any comparison between variants is confounded by copy changes
 *    rather than by the thing being tested.
 *
 * 4. BLAST RADIUS. An LLM outage, a rate limit, a content filter trip, or a malformed
 *    response must not be able to take down page rendering for every customer on the
 *    service. Moving generation off the hot path means the worst case is "we cannot
 *    start a new experiment today", which is a support ticket rather than an incident.
 *
 * 5. PRIVACY. Generating per request means shipping visitor context to a third party on
 *    every page view. Generating ahead of time means the only thing that ever leaves
 *    our infrastructure is an operator-authored brief.
 *
 * So generation happens here, in the control plane, at experiment-creation time. The
 * output is validated, pinned to the variant, and then read by the assignment path like
 * any other static string. Rotation is a background job that mints a new pinned
 * creative; it never regenerates in front of a visitor.
 * =============================================================================
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getEnv } from '../config/env.js';
import type { Creative } from '../core/types.js';
import { creativeSimilarity, DEFAULT_DISTINCTNESS_THRESHOLD } from './distinctness.js';
import type { LlmProvider } from './provider.js';

export interface CreativeBrief {
  /** What the page is and what the business wants. Operator authored. */
  objective: string;
  audience: string;
  tone: string;
  /** Claims that must appear. */
  mustInclude: string[];
  /** Claims that must never appear. */
  mustAvoid: string[];
  /** Extra guidance. */
  constraints?: string;
}

const SYSTEM_PROMPT = `You write conversion-focused microcopy for website experiments.

Hard rules:
- Return only a JSON object. No prose, no markdown fences.
- Never invent statistics, prices, guarantees, or medical/legal claims.
- Never use urgency or pressure language ("only 3 left", "act now").
- Keep the headline under 60 characters.
- Keep the call to action under 25 characters and start with a verb.
- Match the requested tone exactly. Do not drift into hype.
- Write for a specific audience described in the brief, not a generic audience.

Output exactly this shape:
{"candidates":[{"headline":"...","cta":"...","body":"..."}]}`;

const CandidateSchema = z.object({
  headline: z.string().min(1).max(120),
  cta: z.string().min(1).max(60),
  body: z.string().max(400).optional(),
});

const ResponseSchema = z.object({
  candidates: z.array(CandidateSchema).min(1).max(20),
});

export interface GenerationResult {
  creatives: Creative[];
  model: string;
  provider: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Set when generation failed but we fell back to the operator's static copy. */
  degraded: boolean;
  degradedReason?: string;
}

function buildUserPrompt(brief: CreativeBrief, variantKey: string, count: number): string {
  const lines = [
    `Objective: ${brief.objective}`,
    `Audience: ${brief.audience}`,
    `Tone: ${brief.tone}`,
    `Variant arm: ${variantKey}`,
    '',
    `Write ${count} distinct candidate${count === 1 ? '' : 's'}.`,
    'Each candidate must be a genuinely different idea, not a reword of the same one.',
  ];
  if (brief.mustInclude.length) lines.push(`Must include: ${brief.mustInclude.join('; ')}`);
  if (brief.mustAvoid.length) lines.push(`Must avoid: ${brief.mustAvoid.join('; ')}`);
  if (brief.constraints) lines.push(`Constraints: ${brief.constraints}`);
  return lines.join('\n');
}

/**
 * Validate generated copy before it is allowed anywhere near a customer page.
 *
 * Generation is untrusted input. A model will occasionally emit a markdown fence, an
 * invented claim, or a control character. This is a cheap allowlist check, not a
 * defence against a determined attacker, but it catches the failure mode that
 * actually happens in practice: malformed output reaching a page.
 */
export function validateCandidate(
  candidate: unknown,
  brief: CreativeBrief,
): { ok: true; value: z.infer<typeof CandidateSchema> } | { ok: false; reason: string } {
  const parsed = CandidateSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, reason: parsed.error.issues[0]?.message ?? 'schema mismatch' };

  const { headline, cta, body } = parsed.data;
  for (const [field, value] of [
    ['headline', headline],
    ['cta', cta],
    ['body', body ?? ''],
  ] as const) {
    if (/[<>]/.test(value)) {
      return { ok: false, reason: `${field} contains angle brackets; copy is inserted as text, not HTML` };
    }
     
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) {
      return { ok: false, reason: `${field} contains control characters` };
    }
  }
  for (const banned of brief.mustAvoid) {
    if (banned && headline.toLowerCase().includes(banned.toLowerCase())) {
      return { ok: false, reason: `headline contains banned phrase "${banned}"` };
    }
  }
  return { ok: true, value: parsed.data };
}

/** Pull JSON out of a model response that may be wrapped in prose or fences. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  const candidate = fenced ? fenced[1]! : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('no JSON object found in model response');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

export class CreativeGenerator {
  constructor(private readonly provider: LlmProvider | null) {}

  get available(): boolean {
    return this.provider !== null;
  }

  /**
   * Generate candidates for one variant arm.
   *
   * `fallback` is the operator's static copy. If the model is unavailable, misbehaves,
   * or returns something that fails validation, we return the fallback with
   * `degraded: true` and let the caller decide whether to proceed. The experiment can
   * always run with static copy; it just will not have AI-written copy.
   */
  async generateForVariant(
    brief: CreativeBrief,
    variantKey: string,
    fallback: { headline: string; cta?: string; body?: string } | null,
    /**
     * Creatives already pinned to other arms of the same experiment. Candidates that
     * collide with one of these are discarded, because an experiment whose arms say
     * the same thing produces a null result that is indistinguishable from noise.
     */
    alreadyPinned: { headline: string; cta?: string; body?: string }[] = [],
  ): Promise<GenerationResult> {
    const env = getEnv();
    const count = env.LLM_MAX_CANDIDATES;
    const fallbackCreative = (): Creative => ({
      id: randomUUID(),
      source: 'static',
      headline: fallback?.headline ?? variantKey,
      cta: fallback?.cta,
      body: fallback?.body,
      model: null,
      createdAt: new Date().toISOString(),
    });

    if (!this.provider) {
      return {
        creatives: [fallbackCreative()],
        model: 'none',
        provider: 'none',
        usage: { inputTokens: 0, outputTokens: 0 },
        degraded: true,
        degradedReason: 'no LLM provider configured',
      };
    }

    try {
      const res = await this.provider.complete({
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(brief, variantKey, count),
        json: true,
        temperature: 0.85,
        maxTokens: 1200,
      });

      const parsed = ResponseSchema.safeParse(extractJson(res.text));
      if (!parsed.success) {
        throw new Error(`model response failed validation: ${parsed.error.issues[0]?.message}`);
      }

      const creatives: Creative[] = [];
      const rejected: string[] = [];

      for (const candidate of parsed.data.candidates) {
        const check = validateCandidate(candidate, brief);
        if (!check.ok) {
          rejected.push(check.reason);
          continue;
        }

        // Distinctness check against arms already pinned for this experiment.
        const collision = alreadyPinned.find(
          (p) => creativeSimilarity(check.value, p) >= DEFAULT_DISTINCTNESS_THRESHOLD,
        );
        if (collision) {
          rejected.push(`too similar to an existing arm ("${collision.headline}")`);
          continue;
        }

        creatives.push({
          id: randomUUID(),
          source: 'llm',
          headline: check.value.headline,
          cta: check.value.cta,
          body: check.value.body,
          model: res.model,
          createdAt: new Date().toISOString(),
        });
      }

      if (creatives.length === 0) {
        return {
          creatives: [fallbackCreative()],
          model: res.model,
          provider: this.provider.name,
          usage: {
            inputTokens: res.inputTokens ?? 0,
            outputTokens: res.outputTokens ?? 0,
          },
          degraded: true,
          degradedReason: `every candidate rejected: ${rejected[0] ?? 'unknown'}`,
        };
      }

      return {
        creatives,
        model: res.model,
        provider: this.provider.name,
        usage: { inputTokens: res.inputTokens ?? 0, outputTokens: res.outputTokens ?? 0 },
        degraded: false,
        ...(rejected.length ? { degradedReason: `${rejected.length} candidate(s) rejected` } : {}),
      };
    } catch (err) {
      // The whole point of the placement decision: a model failure degrades the
      // control plane, never the data plane.
      return {
        creatives: [fallbackCreative()],
        model: 'unknown',
        provider: this.provider.name,
        usage: { inputTokens: 0, outputTokens: 0 },
        degraded: true,
        degradedReason: (err as Error).message,
      };
    }
  }
}
