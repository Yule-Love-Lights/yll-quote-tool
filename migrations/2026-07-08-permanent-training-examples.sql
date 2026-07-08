-- =====================================================================
-- #141 — the PERMANENT-lighting AI training loop (mirrors #8 Stage A/B for
-- the holiday analyzer, but SEPARATE storage + retrieval — the two verticals
-- teach two different analyzers with different ground-truth shapes).
--
-- One row = one operator-confirmed "the AI traced X, staff confirmed Y"
-- snapshot for a permanent quote: the FOUR satellite side channels
-- (front/left/right/back — see analyzePermanentSatellite/PermanentSatelliteLines)
-- as the ground truth, plus the confirmed street runs + the AI's original
-- pass for provenance. Self-contained (photos copied inline, same precedent
-- as training_examples) so quote_id/design_id are soft links — deleting the
-- quote/design must NOT delete the example.
--
-- SATELLITE-PRIMARY: unlike holiday (street-photo similarity key), the
-- embedding here is the SATELLITE image — that's the analyzer's primary
-- input and the most visually-distinctive artifact per house (roofline shape
-- from above beats a street elevation for "which past house looks like this
-- one"). satellite_photo_base64 is therefore NOT NULL; street is optional
-- (some captures may have no street photo).
--
-- HOW TO APPLY: paste into the Supabase SQL Editor and Run. Idempotent;
-- safe to re-run. NOT applied by this change — the dev applies it.
-- =====================================================================

-- pgvector (vector type + distance operators). Already enabled by the holiday
-- Stage B migration; guarded here too so this file is safe to run standalone.
create extension if not exists vector;

create table if not exists permanent_training_examples (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Soft links back to the operational rows (for "open the quote" in the
  -- review UI). Deleting the quote/design must NOT delete the example.
  quote_id      uuid references quotes(id) on delete set null,
  design_id     uuid references designs(id) on delete set null,
  -- 'auto-send' = captured automatically when staff sent the quote;
  -- 'manual' = the explicit "Save as training example" button.
  source        text not null default 'manual',
  -- Staff can park an oddball example out of the few-shot without deleting.
  excluded      boolean not null default false,
  notes         text,
  address       text,
  -- Street photo snapshot (optional — the front-orientation cross-check
  -- image; some captures may not have one).
  street_photo_base64    text,
  street_media_type      text,
  -- Satellite snapshot — REQUIRED (the analyzer's primary input + the
  -- similarity key for retrieval).
  satellite_photo_base64 text not null,
  satellite_media_type   text not null,
  satellite_feet_per_pixel numeric,
  -- What the AI originally traced (raw PermanentSatelliteAnalysis). NULL = a
  -- fully manual design with no AI run — still a valid example.
  original_analysis   jsonb,
  -- The staff's final word: the confirmed four-side satellite perimeter
  -- ({front,left,right,back}: {points,label}[] — PermanentSatelliteLines
  -- shape) — the ground truth the analyzer is taught to reproduce.
  final_satellite_lines jsonb not null,
  -- The confirmed street-visible runs (PermanentStreetRun[] — side/points/
  -- label), when a street photo + drawn strands are present.
  final_street_runs   jsonb,
  -- Per-side footage/corners + accessories counts at capture time — context
  -- only (not re-taught directly; the geometry above is the lesson).
  final_inputs         jsonb,
  embedding             vector(1024)
);

alter table permanent_training_examples drop constraint if exists permanent_training_examples_source_check;
alter table permanent_training_examples add constraint permanent_training_examples_source_check
  check (source in ('auto-send', 'manual'));

-- Defense in depth (mirrors the #90 all-tables hardening): the service-role
-- key (BYPASSRLS) is the only path that ever reaches this table, so RLS with
-- ZERO policies denies anon/authenticated entirely while every server path
-- keeps working unchanged.
alter table permanent_training_examples enable row level security;

create index if not exists permanent_training_examples_created_at_idx
  on permanent_training_examples (created_at desc);

-- Upsert semantics: a quote keeps at most ONE example per source — re-sending
-- or re-saving REPLACES that snapshot (the latest staff-confirmed state
-- wins). Mirrors training_examples_quote_source_uniq exactly (NOT partial —
-- PostgREST's ON CONFLICT can't infer a partial unique index; NULL quote_ids
-- are distinct under Postgres unique semantics, so orphaned examples stay
-- unconstrained anyway).
drop index if exists permanent_training_examples_quote_source_uniq;
create unique index if not exists permanent_training_examples_quote_source_uniq
  on permanent_training_examples (quote_id, source);

-- Keep updated_at fresh on every write (mirrors jobs / app_settings / inventory_catalog).
create or replace function public.permanent_training_examples_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists permanent_training_examples_updated_at_trigger on public.permanent_training_examples;
create trigger permanent_training_examples_updated_at_trigger
  before update on public.permanent_training_examples
  for each row execute function public.permanent_training_examples_set_updated_at();

-- Cosine-similarity retrieval on the SATELLITE embedding. Returns the
-- non-excluded, embedded examples nearest the query embedding, closest
-- first. `<=>` is pgvector's cosine distance (smaller = more similar).
-- Twin of match_training_examples — same shape, own table.
create or replace function match_permanent_training_examples(
  query_embedding vector(1024),
  match_count int
)
returns setof permanent_training_examples
language sql
stable
as $$
  select *
  from permanent_training_examples
  where excluded = false
    and embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
