-- =====================================================================
-- AI QUOTE TOOL — full canonical schema. Idempotent; safe to re-run.
-- Paste into the Supabase SQL Editor and click Run.
--
-- This single file rebuilds the ENTIRE database from scratch AND brings an
-- existing database fully up to date. It supersedes running db/schema.sql +
-- the individual dated migrations separately (CREATE ... IF NOT EXISTS on a
-- fresh DB; the ADD COLUMN IF NOT EXISTS / DROP-then-CREATE statements patch
-- an existing one).
--
-- Tables:
--   1. quotes            — one per quote (RLS disabled; anon client)
--   2. photo_corrections — human-corrected analyzer outputs (RLS disabled)
--   3. training_houses   — confirmed real-install measurements (RLS disabled)
--   4. reference_assets  — product close-ups for Claude few-shot (RLS disabled)
--   5. designs           — one editable on-photo light design (RLS disabled)
--   6. training_examples — scene-based AI training snapshots (RLS disabled)
-- Storage:
--   designs bucket (private; served via service-role signed URLs)
--
-- Last refreshed: 2026-06-15 — added training_examples.embedding vector(1024)
--   + the match_training_examples RPC + the vector extension (#8 Stage B
--   image-embedding retrieval; see 2026-06-15-training-example-embeddings.sql).
--   2026-06-12 (second pass) added the training_examples
--   table + the designs analysis-provenance/satellite columns (#8 Stage A;
--   see 2026-06-12-training-examples.sql). Earlier same day: REMOVED the
--   renders table + bucket (Gemini render pipeline teardown, task #36; see
--   2026-06-12-drop-renders.sql for tearing down an existing deployment).
--   Prior refresh 2026-06-05 added the designs table + bucket (design-tool
--   integration, task #27 Phase 1); 2026-05-29 folded in db/schema.sql (base
--   tables) plus the post-Apr quotes columns (integration/lifecycle/
--   walkthrough video) and the reference_assets table, so this file alone is
--   a complete rebuild.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. quotes
-- ---------------------------------------------------------------------
create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone default now(),
  customer_name text not null,
  customer_address text not null,
  customer_phone text,
  customer_email text,
  inputs jsonb not null,
  result jsonb not null,
  total numeric(10, 2) not null
);

-- Integration + lifecycle + walkthrough-video columns (added post-base).
-- All nullable; idempotent so an existing quotes table is patched in place.
alter table quotes
  add column if not exists highlevel_contact_id text,
  add column if not exists highlevel_opportunity_id text,
  add column if not exists homeworks_sent_at timestamptz,
  add column if not exists homeworks_webhook_response jsonb,
  add column if not exists customer_approved_at timestamptz,
  add column if not exists approval_snapshot jsonb,
  add column if not exists quote_sent_at timestamptz,
  add column if not exists homeworks_signed_at timestamptz,
  add column if not exists homeworks_contract_id text,
  add column if not exists video_kind text,
  add column if not exists video_src text,
  add column if not exists video_poster text,
  add column if not exists video_title text,
  add column if not exists video_duration_sec integer,
  -- service_type (added 2026-06-24, #58 Phase 2a): Holiday/Permanent/Event
  -- categorization powering the dashboard per-service sections. text + CHECK
  -- rather than a PG enum so adding values later is a simple ALTER (no
  -- ALTER TYPE dance). Nullable; the app reads NULL as 'holiday' (the legacy
  -- default), and the migration backfills existing rows to 'holiday'.
  add column if not exists service_type text,
  -- view receipt (added 2026-06-25, #68): when the customer opens their portal
  -- link, /api/quotes/[id]/view stamps these so the admin table shows a "Viewed"
  -- badge and staff get a GHL email per open. viewed_at = first open,
  -- last_viewed_at = most recent, view_count = total opens.
  add column if not exists viewed_at timestamptz,
  add column if not exists last_viewed_at timestamptz,
  add column if not exists view_count integer not null default 0;

alter table quotes drop constraint if exists quotes_video_kind_check;
alter table quotes add constraint quotes_video_kind_check
  check (video_kind is null or video_kind in ('youtube', 'mp4'));

alter table quotes drop constraint if exists quotes_service_type_check;
alter table quotes add constraint quotes_service_type_check
  check (service_type is null or service_type in ('holiday', 'permanent', 'event'));

-- Backfill legacy NULLs to 'holiday' (idempotent).
update quotes set service_type = 'holiday' where service_type is null;

alter table quotes disable row level security;

create index if not exists quotes_created_at_idx on quotes (created_at desc);
create index if not exists quotes_highlevel_contact_id_idx
  on quotes (highlevel_contact_id) where highlevel_contact_id is not null;
create index if not exists quotes_homeworks_pending_idx
  on quotes (created_at desc) where homeworks_sent_at is null;
create index if not exists quotes_awaiting_customer_idx
  on quotes (quote_sent_at desc) where quote_sent_at is not null and customer_approved_at is null;
create index if not exists quotes_signed_idx
  on quotes (homeworks_signed_at desc) where homeworks_signed_at is not null;
create index if not exists quotes_service_type_idx on quotes (service_type);
create index if not exists quotes_viewed_idx
  on quotes (viewed_at desc) where viewed_at is not null;


-- ---------------------------------------------------------------------
-- 2. photo_corrections
-- ---------------------------------------------------------------------
create table if not exists photo_corrections (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone default now(),
  photo_base64 text not null,
  photo_media_type text not null,
  original_analysis jsonb not null,
  corrected_santas_footage numeric(10, 2) not null,
  corrected_santas_difficulty text not null,
  corrected_santas_lines jsonb not null,
  corrected_gingerbread_footage numeric(10, 2) not null,
  corrected_gingerbread_difficulty text not null,
  corrected_gingerbread_lines jsonb not null,
  corrected_mini_light_detections jsonb not null default '[]'::jsonb,
  notes text
);

-- Extra correction fields the quote/new page now captures (all nullable).
alter table photo_corrections
  add column if not exists corrected_mini_light_detections jsonb not null default '[]'::jsonb,
  add column if not exists corrected_c9_lines jsonb,
  add column if not exists corrected_winter_wonderland_footage numeric,
  add column if not exists corrected_satellite_santas_lines jsonb,
  add column if not exists corrected_satellite_gingerbread_lines jsonb,
  add column if not exists corrected_satellite_c9_lines jsonb,
  add column if not exists corrected_wreath_detections jsonb,
  add column if not exists corrected_spritzer_detections jsonb,
  add column if not exists corrected_garland_detections jsonb;

alter table photo_corrections disable row level security;
create index if not exists photo_corrections_created_at_idx on photo_corrections (created_at desc);


-- ---------------------------------------------------------------------
-- 3. training_houses
-- ---------------------------------------------------------------------
create table if not exists training_houses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone default now(),
  address text,
  year_completed integer,
  house_style text,
  notes text,
  photos jsonb not null default '[]'::jsonb,
  santas_footage numeric(10, 2),
  santas_difficulty text,
  santas_lines jsonb default '[]'::jsonb,
  gingerbread_footage numeric(10, 2),
  gingerbread_difficulty text,
  gingerbread_lines jsonb default '[]'::jsonb,
  winter_wonderland_footage numeric(10, 2),
  winter_wonderland_difficulty text,
  mini_light_detections jsonb not null default '[]'::jsonb,
  spritzers jsonb not null default '[]'::jsonb,
  wreaths jsonb not null default '[]'::jsonb,
  garland jsonb not null default '[]'::jsonb
);

-- Garland bounding-box detections + c9 polyline (added post-base, nullable).
alter table training_houses
  add column if not exists garland_detections jsonb,
  add column if not exists c9_lines jsonb;

alter table training_houses disable row level security;
create index if not exists training_houses_created_at_idx on training_houses (created_at desc);
create index if not exists training_houses_address_idx on training_houses (address);


-- ---------------------------------------------------------------------
-- 4. reference_assets
--    Product close-ups (spritzer/wreath/garland) injected into Claude calls
--    as few-shot context. Reached via the anon client, so RLS is disabled to
--    match photo_corrections / training_houses. (See referenceAssets.ts.)
-- ---------------------------------------------------------------------
create table if not exists reference_assets (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone default now(),
  asset_type text not null,                 -- 'spritzer' | 'wreath' | 'garland'
  size text not null,                       -- e.g. '24', '30noble', '9ft'
  tier text,                                -- nullable
  base64 text not null,                     -- image bytes, base64-encoded
  media_type text not null,                 -- e.g. 'image/png'
  caption text,                             -- nullable
  active boolean not null default true,
  constraint reference_assets_asset_type_check
    check (asset_type in ('spritzer', 'wreath', 'garland'))
);

alter table reference_assets disable row level security;
create index if not exists reference_assets_created_at_idx on reference_assets (created_at desc);
create index if not exists reference_assets_asset_type_idx on reference_assets (asset_type);


-- ---------------------------------------------------------------------
-- 5. designs  (design-tool integration, Path B — task #27 Phase 1)
--    One editable on-photo light design. The `scene` jsonb is the design
--    tool's Scene shape (yardsticks + items + brightness). A design is an
--    INDEPENDENT record with its own id and an OPTIONAL link to a quote, so it
--    can exist before a quote is saved (the builder creates it when the Street
--    View photo is pulled) and even with no quote at all (future standalone
--    use). The quote link is set when the operator clicks "Calculate Quote".
--    Reached via the service-role client (server routes), so RLS is disabled
--    to match quotes.
-- ---------------------------------------------------------------------
create table if not exists designs (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid references quotes(id) on delete set null,
  photo_path text,                                          -- Storage path: {designId}/photo.<ext>
  photo_w integer,
  photo_h integer,
  scene jsonb not null default '{"yardsticks":[],"items":[]}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Analysis provenance + satellite context (#8 Stage A, 2026-06-12): the AI's
-- raw analysis from the last analyze, the satellite image it measured against
-- (path in the designs bucket + dims + deterministic feet-per-pixel), and the
-- staff's final satellite measurement polylines. Idempotent patch for
-- existing deployments.
alter table designs
  add column if not exists seed_analysis jsonb,
  add column if not exists satellite_path text,
  add column if not exists satellite_w integer,
  add column if not exists satellite_h integer,
  add column if not exists satellite_feet_per_pixel numeric,
  add column if not exists satellite_lines jsonb;

alter table designs disable row level security;

-- At most ONE design per quote (linked designs); unlimited UNLINKED designs
-- (quote_id NULL — Postgres treats NULLs as distinct in the partial index).
create unique index if not exists designs_quote_id_uniq
  on designs (quote_id) where quote_id is not null;
create index if not exists designs_created_at_idx on designs (created_at desc);

create or replace function designs_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists designs_updated_at_trigger on designs;
create trigger designs_updated_at_trigger
  before update on designs
  for each row execute function designs_set_updated_at();

-- Storage bucket for design artifacts (base house photo + satellite image +
-- custom-item images). Private; reads go through service-role signed URLs.
insert into storage.buckets (id, name, public)
values ('designs', 'designs', false)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- 6. training_examples  (#8 Stage A — scene-based AI training snapshots)
--    One row = one complete, SELF-CONTAINED "the AI seeded X, staff
--    corrected to Y" snapshot: both photos copied inline (base64), the raw
--    AI analysis, the staff's FINAL scene + final measurement inputs.
--    quote_id/design_id are soft links (SET NULL) so examples survive
--    deleting the quotes they came from. Service-role access only.
-- ---------------------------------------------------------------------
create table if not exists training_examples (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  quote_id uuid references quotes(id) on delete set null,
  design_id uuid references designs(id) on delete set null,
  source text not null default 'manual',     -- 'auto-send' | 'manual'
  excluded boolean not null default false,   -- park an oddball out of the few-shot
  notes text,
  address text,
  street_photo_base64 text,
  street_media_type text,
  street_w integer,
  street_h integer,
  satellite_base64 text,
  satellite_media_type text,
  satellite_w integer,
  satellite_h integer,
  satellite_feet_per_pixel numeric,
  satellite_lines jsonb,                     -- {santas,gingerbread,c9,santasFootage,gingerbreadFootage}
  original_analysis jsonb,                   -- raw PhotoAnalysisResult; NULL = manual design, no AI run
  final_scene jsonb not null,
  final_inputs jsonb not null                -- footages/difficulties subset of QuoteInputs
);

alter table training_examples drop constraint if exists training_examples_source_check;
alter table training_examples add constraint training_examples_source_check
  check (source in ('auto-send', 'manual'));

alter table training_examples disable row level security;

create index if not exists training_examples_created_at_idx
  on training_examples (created_at desc);

-- Upsert semantics: a quote keeps at most ONE example per source — re-sending
-- or re-saving REPLACES that snapshot (the latest staff-confirmed state wins).
-- NOT partial: PostgREST's ON CONFLICT can't infer a partial unique index
-- (42P10); NULL quote_ids are distinct under unique semantics anyway.
create unique index if not exists training_examples_quote_source_uniq
  on training_examples (quote_id, source);

-- #8 Stage B — image-embedding similarity retrieval. Each example's street
-- photo is embedded (Voyage voyage-multimodal-3.5, 1024 dims — under pgvector's
-- 2000-dim index ceiling; no ANN index needed at this scale). The match RPC
-- returns the nearest non-excluded examples by cosine distance. App degrades to
-- recency when the embedding is null, so this is additive.
create extension if not exists vector;
alter table training_examples
  add column if not exists embedding vector(1024);

create or replace function match_training_examples(
  query_embedding vector(1024),
  match_count int
)
returns setof training_examples
language sql
stable
as $$
  select *
  from training_examples
  where excluded = false
    and embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;
