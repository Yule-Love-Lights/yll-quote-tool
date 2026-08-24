-- Lightweight similarity ranking for the mini-light retrieval bias
-- (fewShot.ts's MINI_BIAS_POOL_SIZE / biasForMiniLights).
--
-- The existing match_training_examples RPC returns `setof training_examples`
-- -- every column, including street_photo_base64 / satellite_base64. Measured
-- live 2026-08-24: avg ~981 KB of images per row (683 KB street + 298 KB
-- satellite), up to ~4.9 MB on one row. Widening the similarity candidate
-- pool from FEW_SHOT_LIMIT (8) to MINI_BIAS_POOL_SIZE (24) so
-- biasForMiniLights has room to search meant fetching up to ~23.5 MB of
-- images per analyze call just to RANK candidates -- two thirds of which
-- were discarded immediately after ranking, on a maxDuration-bounded handler
-- that already spends a large share of its budget on the vision call itself.
--
-- This sibling RPC returns only what ranking + mini-light richness scoring
-- need -- id, final_scene, and the photo dims needed to project it (jsonb,
-- measured ~6.8 KB avg per row -- cheap enough that a maintained count
-- column isn't needed). The FULL base64 rows for the final FEW_SHOT_LIMIT
-- selected few-shot examples are still fetched afterward, by id
-- (getTrainingExamplesByIds in src/lib/trainingExamples.ts) -- this function
-- is ranking-only, never a substitute for the full-row fetch.
--
-- Does NOT modify match_training_examples's existing signature or behavior --
-- this is an ADDITIVE sibling function so any other caller of the original
-- RPC is unaffected.
--
-- IDEMPOTENT (create or replace). NOT YET APPLIED to the live database as of
-- this PR -- reported per this repo's migration-application convention
-- (AGENTS.md: CHECK-constraint / function-behavior changes ask first; this
-- is a new additive function, but flagging for the owner's explicit apply
-- rather than auto-applying per this task's brief).
--
-- HOW TO APPLY: paste into the Supabase SQL Editor and Run.

create or replace function match_training_examples_lite(
  query_embedding vector(1024),
  match_count int
)
returns table (
  id uuid,
  final_scene jsonb,
  street_w int,
  street_h int
)
language sql
stable
as $$
  select id, final_scene, street_w, street_h
  from training_examples
  where excluded = false
    and embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
