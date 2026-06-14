-- =====================================================================
-- #8 Stage A — scene-based training examples (2026-06-12)
--
-- Two halves:
--
-- 1. ANALYSIS PROVENANCE ON DESIGNS. The builder now persists, per design:
--    the AI's raw analysis from the last analyze (seed_analysis), the
--    satellite image it measured against (private designs bucket, path +
--    dims + the deterministic feet-per-pixel scale), and the staff's final
--    satellite measurement polylines. Without these, "what did the AI
--    originally say" and "what did staff confirm" exist only in browser
--    memory and are lost on reload — and the training capture below could
--    never be assembled server-side from a reopened quote.
--
-- 2. THE training_examples TABLE. One row = one complete, SELF-CONTAINED
--    "the AI seeded X, staff corrected to Y" snapshot: both photos copied
--    inline (base64, matching the photo_corrections precedent), the raw AI
--    analysis, the staff's FINAL scene + final measurement inputs. Self-
--    contained on purpose — quote_id/design_id are soft links (SET NULL)
--    so examples survive staff deleting the test quotes they came from.
--    These rows are the few-shot library that replaces photo_corrections
--    (which only feeds the model until Jason's planned full data wipe).
--
-- HOW TO APPLY: paste into the Supabase SQL Editor and Run. Idempotent;
-- safe to re-run.
-- =====================================================================

-- 1. Designs: analysis provenance + satellite context.
alter table designs
  add column if not exists seed_analysis jsonb,
  add column if not exists satellite_path text,
  add column if not exists satellite_w integer,
  add column if not exists satellite_h integer,
  add column if not exists satellite_feet_per_pixel numeric,
  add column if not exists satellite_lines jsonb;

-- 2. Training examples.
create table if not exists training_examples (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- Soft links back to the operational rows (for "open the quote" in the
  -- review UI). Deleting the quote/design must NOT delete the example.
  quote_id uuid references quotes(id) on delete set null,
  design_id uuid references designs(id) on delete set null,
  -- 'auto-send' = captured automatically when staff sent the quote;
  -- 'manual' = the explicit "Save as training example" button.
  source text not null default 'manual',
  -- Staff can park an oddball example out of the few-shot without deleting.
  excluded boolean not null default false,
  notes text,
  address text,
  -- Street photo snapshot (the design's base photo at capture time).
  street_photo_base64 text,
  street_media_type text,
  street_w integer,
  street_h integer,
  -- Satellite snapshot — the image, its scale, and the staff-confirmed
  -- measurement polylines ({santas,gingerbread,c9,santasFootage,
  -- gingerbreadFootage}). THIS is the satellite training data the old
  -- corrections system never captured.
  satellite_base64 text,
  satellite_media_type text,
  satellite_w integer,
  satellite_h integer,
  satellite_feet_per_pixel numeric,
  satellite_lines jsonb,
  -- What the AI originally said (raw PhotoAnalysisResult). NULL = a fully
  -- manual design with no AI run — still a valid example.
  original_analysis jsonb,
  -- The staff's final word: the refined scene + the measurement inputs the
  -- quote was actually priced with (footages/difficulties subset).
  final_scene jsonb not null,
  final_inputs jsonb not null
);

alter table training_examples drop constraint if exists training_examples_source_check;
alter table training_examples add constraint training_examples_source_check
  check (source in ('auto-send', 'manual'));

-- Service-role access only (matches designs).
alter table training_examples disable row level security;

create index if not exists training_examples_created_at_idx
  on training_examples (created_at desc);

-- Upsert semantics: a quote keeps at most ONE example per source — re-sending
-- or re-saving REPLACES that snapshot (the latest staff-confirmed state wins).
-- NOT a partial index on purpose: PostgREST's ON CONFLICT (quote_id, source)
-- can't infer a partial unique index (error 42P10). NULL quote_ids are
-- distinct under Postgres unique semantics, so orphaned examples (quote
-- deleted → SET NULL) stay unconstrained anyway.
drop index if exists training_examples_quote_source_uniq;
create unique index if not exists training_examples_quote_source_uniq
  on training_examples (quote_id, source);
