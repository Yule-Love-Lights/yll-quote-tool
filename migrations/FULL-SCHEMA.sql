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
-- Storage:
--   designs bucket (private; served via service-role signed URLs)
--
-- Last refreshed: 2026-06-12 — REMOVED the renders table + bucket (Gemini
--   render pipeline teardown, task #36; see 2026-06-12-drop-renders.sql for
--   tearing down an existing deployment). Prior refresh 2026-06-05 added the
--   designs table + bucket (design-tool integration, task #27 Phase 1);
--   2026-05-29 folded in db/schema.sql (base tables) plus the post-Apr quotes
--   columns (integration/lifecycle/walkthrough video) and the
--   reference_assets table, so this file alone is a complete rebuild.
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
  add column if not exists video_duration_sec integer;

alter table quotes drop constraint if exists quotes_video_kind_check;
alter table quotes add constraint quotes_video_kind_check
  check (video_kind is null or video_kind in ('youtube', 'mp4'));

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

-- Storage bucket for design artifacts (base house photo + custom-item images).
-- Private; reads go through service-role signed URLs.
insert into storage.buckets (id, name, public)
values ('designs', 'designs', false)
on conflict (id) do nothing;
