-- Stake Lighting on training_houses — parallel of the winter_wonderland_* columns.
-- The new "Stake Lighting" category (independent staked ground runs, billed at its
-- own $6/$7/$8 per-ft rates) is captured on the completed-job training form just
-- like Winter Wonderland / C9 custom runs. Quotes store stake lighting in the
-- inputs jsonb blob (no migration), but training_houses uses real columns, so add:
--   stake_lighting_footage    — derived/typed linear footage (numeric, like winter_wonderland_footage)
--   stake_lighting_difficulty — 'easy' | 'medium' | 'hard' (text; enum enforced in app code)
--   stake_lines               — the traced satellite polylines (jsonb, like c9_lines)
--
-- Additive + idempotent. Apply to the live Supabase (Chrome ext + SQL editor)
-- BEFORE merging — prod auto-deploys master and listTrainingHouses selects these
-- columns; a missing column would error the whole read.
ALTER TABLE training_houses
  ADD COLUMN IF NOT EXISTS stake_lighting_footage    numeric(10,2),
  ADD COLUMN IF NOT EXISTS stake_lighting_difficulty text,
  ADD COLUMN IF NOT EXISTS stake_lines               jsonb;
