/**
 * Request validation.
 *
 * Everything that crosses the network boundary is parsed here. Two reasons: a
 * malformed request must produce a clean 400 rather than a stack trace, and every
 * value that reaches the database or the hasher must have a bounded size. An unbounded
 * visitorId is both a storage-abuse vector and a way to burn CPU on the hot path.
 */

import { z } from 'zod';

export const MAX_ID_LEN = 128;
export const MAX_EXPERIMENTS_PER_REQUEST = 50;

const identifier = z
  .string()
  .min(1)
  .max(MAX_ID_LEN)
  // Slug-ish: letters, digits, dot, dash, underscore. No control characters, which is
  // what keeps ids safe as hash inputs and safe in URLs and log lines.
  .regex(/^[A-Za-z0-9._-]+$/, 'must contain only letters, digits, dot, dash or underscore');

export const namespaceSchema = identifier;
export const experimentIdSchema = identifier;
export const variantKeySchema = identifier;

/**
 * Visitor identity.
 *
 * A visitor id is customer-controlled and therefore untrusted. It is length bounded
 * and character restricted, but we do not require a specific format, because the
 * identity strategy is the customer's choice: a first-party cookie value, a hashed
 * user id, a session id, or a composite.
 */
export const visitorIdSchema = z
  .string()
  .min(1)
  .max(256)
   
  .regex(/^[^\u0000-\u001F\u007F]+$/, 'must not contain control characters');

export const assignBodySchema = z
  .object({
    visitorId: visitorIdSchema,
    namespace: namespaceSchema.default('default'),
    /** Explicit list, or omitted to get every running experiment in the namespace. */
    experiments: z.array(experimentIdSchema).max(MAX_EXPERIMENTS_PER_REQUEST).optional(),
  })
  .strict();

export const trackEventSchema = z
  .object({
    eventId: z.string().uuid(),
    type: z.enum(['exposure', 'conversion']),
    namespace: namespaceSchema.default('default'),
    experimentId: experimentIdSchema,
    variantKey: variantKeySchema,
    visitorId: visitorIdSchema,
    /** Milliseconds since epoch. */
    ts: z.number().int().nonnegative().optional(),
    goal: z.string().max(128).nullish(),
    properties: z.record(z.unknown()).nullish(),
  })
  .strict();

export const trackBodySchema = z.union([trackEventSchema, z.object({ events: z.array(trackEventSchema).min(1).max(100) }).strict()]);

// ---------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------

export const creativeBriefSchema = z
  .object({
    objective: z.string().min(1).max(2000),
    audience: z.string().min(1).max(1000),
    tone: z.string().min(1).max(500),
    mustInclude: z.array(z.string().max(200)).max(20).default([]),
    mustAvoid: z.array(z.string().max(200)).max(20).default([]),
    constraints: z.string().max(1000).optional(),
  })
  .strict();

export const createExperimentSchema = z
  .object({
    id: experimentIdSchema,
    namespace: namespaceSchema.default('default'),
    status: z.enum(['draft', 'running']).default('draft'),
    allocationBps: z.number().int().min(0).max(10000).default(10000),
    salt: z.string().max(128).nullish(),
    variants: z
      .array(
        z
          .object({
            key: variantKeySchema,
            weightBps: z.number().int().min(0).max(10000),
            /** Static content. Required unless a creative brief is supplied. */
            creative: z
              .object({
                headline: z.string().min(1).max(200),
                cta: z.string().max(100).optional(),
                body: z.string().max(2000).optional(),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    /** If present, generate AI copy for every variant and pin the first candidate. */
    creativeBrief: creativeBriefSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const keys = new Set<string>();
    for (const v of val.variants) {
      if (keys.has(v.key)) {
        ctx.addIssue({ code: 'custom', message: `duplicate variant key "${v.key}"` });
      }
      keys.add(v.key);
    }
    const total = val.variants.reduce((a, v) => a + v.weightBps, 0);
    if (total <= 0) {
      ctx.addIssue({ code: 'custom', message: 'variant weights must sum to more than zero' });
    }
    if (!val.creativeBrief) {
      for (const v of val.variants) {
        if (!v.creative) {
          ctx.addIssue({
            code: 'custom',
            message: `variant "${v.key}" has no creative and no creativeBrief was supplied`,
          });
        }
      }
    }
  });

export const patchExperimentSchema = z
  .object({
    status: z.enum(['draft', 'running', 'paused', 'archived']).optional(),
    allocationBps: z.number().int().min(0).max(10000).optional(),
    salt: z.string().max(128).nullish(),
    variants: z
      .array(
        z
          .object({
            key: variantKeySchema,
            weightBps: z.number().int().min(0).max(10000),
          })
          .strict(),
      )
      .min(1)
      .max(10)
      .optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.variants) {
      const total = val.variants.reduce((a, v) => a + v.weightBps, 0);
      if (total <= 0) {
        ctx.addIssue({ code: 'custom', message: 'variant weights must sum to more than zero' });
      }
    }
  });
