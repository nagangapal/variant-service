-- Schema
--
-- Key modelling decisions, all of which are defended in DESIGN.md:
--
--  1. Natural, human-readable keys (namespace, experiment id) rather than UUIDs.
--     Customers write these into their own JavaScript. A UUID forces every customer to
--     copy an opaque token and makes their code unreadable.
--
--  2. No assignment table. Assignment is a pure hash of (namespace, experiment,
--     visitor), so storing it would be storing a redundant copy of something we can
--     recompute. This is the single most important absence in the schema.
--
--  3. The events table is deliberately denormalised. It carries no foreign key to
--     experiments, and repeats namespace/experiment_id as text. At high write volume a
--     FK costs a probe on every insert and blocks vacuum on the parent. We accept
--     possible orphan rows in exchange for cheap appends, and we reap them in a
--     periodic retention job.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Control plane
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS experiments (
  namespace      TEXT        NOT NULL,
  id             TEXT        NOT NULL,
  status         TEXT        NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft','running','paused','archived')),
  -- Share of all visitors admitted to the experiment. 10_000 = 100%.
  allocation_bps INTEGER     NOT NULL DEFAULT 10000
                             CHECK (allocation_bps BETWEEN 0 AND 10000),
  -- Deliberate re-randomisation escape hatch. NULL in normal operation.
  salt           TEXT,
  version        BIGINT      NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (namespace, id)
);

CREATE TABLE IF NOT EXISTS variants (
  namespace     TEXT    NOT NULL,
  experiment_id TEXT    NOT NULL,
  key           TEXT    NOT NULL,
  -- Relative weight, normalised at read time. Not required to sum to 10_000.
  weight_bps    INTEGER NOT NULL CHECK (weight_bps >= 0),
  PRIMARY KEY (namespace, experiment_id, key),
  FOREIGN KEY (namespace, experiment_id)
    REFERENCES experiments(namespace, id) ON DELETE CASCADE
);

-- Pinned content served on the hot path. The LLM writes here at experiment-creation
-- time; the assignment path only ever reads a row that already exists.
CREATE TABLE IF NOT EXISTS creatives (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  namespace     TEXT    NOT NULL,
  experiment_id TEXT    NOT NULL,
  variant_key   TEXT    NOT NULL,
  -- 'fallback' is added by 002_creative_source_fallback.sql; it marks copy that exists
  -- only because generation failed.
  source        TEXT    NOT NULL CHECK (source IN ('static','llm')),
  headline      TEXT    NOT NULL,
  cta           TEXT,
  body          TEXT,
  model         TEXT,
  -- Exactly one pinned creative per variant. Enforced by a partial unique index so
  -- that swapping creatives is a single atomic transaction.
  pinned        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (namespace, experiment_id)
    REFERENCES experiments(namespace, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS creatives_one_pinned_per_variant
  ON creatives (namespace, experiment_id, variant_key) WHERE pinned;

-- ---------------------------------------------------------------------------
-- Data plane
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS events (
  -- Client-generated. Uniqueness is what makes a retried beacon a no-op rather than a
  -- double count, so this is a hard constraint rather than an application check.
  event_id      UUID        NOT NULL UNIQUE,
  type          TEXT        NOT NULL CHECK (type IN ('exposure','conversion')),
  namespace     TEXT        NOT NULL,
  experiment_id TEXT        NOT NULL,
  variant_key   TEXT        NOT NULL,
  visitor_id    TEXT        NOT NULL,
  goal          TEXT,
  properties    JSONB,
  -- Client-reported time, clamped server-side so a bad client clock cannot corrupt
  -- the results window.
  ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Results read COUNT(DISTINCT visitor_id) grouped by variant. This index covers that.
CREATE INDEX IF NOT EXISTS events_results_cover
  ON events (namespace, experiment_id, type, variant_key, visitor_id);

-- Attribution check: did this visitor actually get exposed before converting?
CREATE INDEX IF NOT EXISTS events_attribution
  ON events (namespace, experiment_id, visitor_id, type);

CREATE INDEX IF NOT EXISTS events_received ON events (received_at);
