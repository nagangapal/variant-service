/**
 * Core domain types.
 *
 * Money/basis-points convention: every weight and allocation in this system is an
 * integer in [0, 10_000] ("bps"). Integers avoid float drift when you sum weights,
 * and 10_000 gives us 0.01% resolution, which is finer than any real traffic split.
 */

export const BUCKET_COUNT = 10_000;

export type ExperimentStatus = 'draft' | 'running' | 'paused' | 'archived';

export interface VariantDef {
  key: string;
  /** Relative weight. Does not need to sum to 10_000; normalised at read time. */
  weightBps: number;
}

/**
 * Where a creative's copy came from.
 *
 * 'fallback' means generation was attempted and failed, so the experiment is running on
 * a placeholder. It is tracked separately from 'static' because a deliberate static
 * creative is a valid choice while a fallback is a defect, and only the operator can
 * tell the difference if the two look alike.
 */
export type CreativeSource = 'static' | 'llm' | 'fallback';

export interface Creative {
  id: string;
  source: CreativeSource;
  /** Immutable once stored. This is what the assignment endpoint serves. */
  headline: string;
  cta?: string;
  body?: string;
  /** Which LLM produced it, if any. Null for static creatives. */
  model?: string | null;
  createdAt: string;
}

export interface Experiment {
  namespace: string;
  id: string;
  status: ExperimentStatus;
  /**
   * Share of the total visitor population admitted into the experiment.
   * 10_000 = everyone. 2_000 = 20% participate, 80% are held out.
   */
  allocationBps: number;
  /**
   * Optional per-experiment salt. Changing it deliberately re-randomises the whole
   * experiment (every visitor may move variant). Left null for normal operation.
   */
  salt: string | null;
  variants: VariantDef[];
  /** Creative is pinned per variant key so the hot path serves static strings. */
  creatives: Record<string, Creative>;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** Normalised, pre-computed assignment plan. Built once per config refresh. */
export interface VariantPlanEntry {
  key: string;
  /** Upper bound of this variant's bucket range, in bps. Monotonically increasing. */
  cumulativeBps: number;
  creative: Creative | null;
}

export interface CompiledExperiment {
  namespace: string;
  id: string;
  version: number;
  status: ExperimentStatus;
  allocationBps: number;
  salt: string;
  /** Cumulative variant boundaries. Empty when the experiment has no usable variants. */
  plan: VariantPlanEntry[];
}

export interface Assignment {
  experimentId: string;
  variantKey: string | null;
  /** Stable creative id, when the variant has one pinned. */
  creativeId: string | null;
  /** Why the visitor did or did not get a variant. Useful for debugging and metrics. */
  reason:
    | 'assigned'
    | 'not_in_allocation'
    | 'experiment_paused'
    | 'experiment_not_found'
    | 'experiment_not_running'
    | 'no_variants';
  creative: Creative | null;
}

export type EventType = 'exposure' | 'conversion';

export interface TrackEvent {
  /** Client-generated idempotency key. Repeats are dropped, not double counted. */
  eventId: string;
  type: EventType;
  namespace: string;
  experimentId: string;
  variantKey: string;
  visitorId: string;
  /** Milliseconds since epoch. */
  ts: number;
  /** Optional goal name for conversions, e.g. "signup". */
  goal?: string | null;
  properties?: Record<string, unknown> | null;
}
