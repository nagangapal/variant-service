-- Add 'fallback' as a creative source.
--
-- A creative whose source is 'fallback' is a placeholder: content generation was
-- attempted and failed. That is a different situation from a deliberate 'static'
-- creative, and conflating them was a real defect -- the create response claimed
-- source 'static', so an operator could not tell a chosen headline from a failure, and
-- the start guard could not refuse to run an experiment on placeholder copy.
--
-- The constraint is dropped and re-added rather than altered because Postgres cannot
-- change a CHECK constraint in place, and because naming the new set explicitly makes
-- the intent readable.
ALTER TABLE creatives DROP CONSTRAINT IF EXISTS creatives_source_check;

ALTER TABLE creatives
  ADD CONSTRAINT creatives_source_check CHECK (source IN ('static','llm','fallback'));
