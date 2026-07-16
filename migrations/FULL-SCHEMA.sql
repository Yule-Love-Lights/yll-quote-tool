-- =====================================================================
-- AI QUOTE TOOL — full canonical schema. Idempotent; safe to re-run.
-- Paste into the Supabase SQL Editor and click Run.
--
-- GENERATED (audit #110 wave 2, finding W2-007): this file is produced by
-- reconciling ALL 45 dated migrations/*.sql files IN DATE ORDER (creates,
-- alters, drops, RLS enable/disable applied in sequence) into one canonical
-- end-state schema. It supersedes running db/schema.sql + the individual
-- dated migrations separately (CREATE ... IF NOT EXISTS on a fresh DB; the
-- ADD COLUMN IF NOT EXISTS / DROP-then-CREATE statements patch an existing
-- one). The dated migrations remain the append-only source of truth for
-- HOW the schema got here; this file is WHERE it landed.
--
-- Regenerated: 2026-07-03 @ commit f4b398d, reconciling every migration
-- through 2026-07-02-designs-photo-title.sql (45 files). Previous refresh
-- (2026-06-15) covered only 6 of the now-20 tables — see the superseded
-- header this replaces in git history.
--
-- Tables (20 LIVE + 2 REMOVED tombstones below; RLS ENABLED on all 20 live
-- ones — #90 defense in depth). Two RLS postures coexist by design (see
-- migrations/2026-06-28-dashboard-tables.sql header + the W2-006 note in
-- 2026-06-28-enable-rls-all-tables.sql):
--   * "classic" PII tables (quotes, designs, training_houses, reference_assets,
--     training_examples, app_settings, custom_uploads, inventory_catalog,
--     inventory_on_hand, customers, properties, jobs, invoices,
--     quote_view_events): RLS enabled with NO policies. Every path uses the
--     service-role client, which bypasses RLS — anon/authenticated get nothing.
--   * dashboard tables (dashboard_contacts, inbox_items, follow_ups,
--     dashboard_activity, integration_tokens, sync_cursors): RLS enabled WITH
--     explicit policies — authenticated operators get SELECT (+UPDATE on the
--     three operator tables); integration_tokens/sync_cursors are deny-all to
--     authenticated; service_role gets ALL on every table (bypasses RLS
--     anyway; policy exists for documentation/intent).
--
--    1. quotes              — one per quote
--    2. quote_view_events   — per-view read-receipt log (2026-06-25)
--       photo_corrections   — REMOVED 2026-06-25 (tombstone, not counted live)
--       renders             — REMOVED 2026-06-12 (tombstone, not counted live)
--    3. training_houses     — confirmed real-install measurements
--    4. reference_assets    — product close-ups for Claude few-shot
--    5. designs             — one editable on-photo light design (+ extra photos)
--    6. training_examples   — scene-based AI training snapshots
--    7. app_settings        — global editor/render settings (key→jsonb)
--    8. custom_uploads      — staff-uploaded custom graphic library
--    9. inventory_catalog   — supplier (Thunder Lighting) catalog
--   10. inventory_on_hand   — curated warehouse stock list
--   11. customers           — stable customer identity (#83 Phase 5)
--   12. properties          — one-or-more service addresses per customer
--   13. jobs                — unified billing (#83) + fulfillment (#82) job
--   14. invoices            — the money tail of the Jobber-flow (#83 Phase 3)
--   15. dashboard_contacts  — one card per human, collapsed across channels (#58)
--   16. inbox_items         — unified inbound-message feed (#58)
--   17. follow_ups          — "due today" reminders (#58)
--   18. dashboard_activity  — append-only audit trail (#58)
--   19. integration_tokens  — Gmail OAuth, server-only (#58; not yet read/
--       written anywhere in src/ as of this regen — table exists, wiring doesn't)
--   20. sync_cursors        — per-source sync state/health, server-only (#58)
--
-- Sequences: quote_number_seq, job_number_seq, invoice_number_seq (all
-- START WITH 1000) + the shared allocate_display_number(seq_name) RPC.
--
-- Storage buckets: designs (private), custom-uploads (public).
-- renders bucket was REMOVED 2026-06-12 — delete by hand in the Supabase UI
-- if it still exists (buckets aren't managed by plain SQL).
--
-- KNOWN GAP: training_houses' base shape (id/address/photos/... plus 8
-- columns — wreath_detections, spritzer_detections, scale_anchor,
-- didnt_install, ai_failure_notes, cost_materials, cost_labor_hours, revenue)
-- predates migrations/ entirely (hand-created in Supabase, like
-- reference_assets originally was). No dated migration owns these; they're
-- reconstructed here from src/lib/training.ts's StoredTrainingHouse type so
-- this file doesn't 500 a fresh rebuild. See the table's own header comment.
--
-- W2-006 rebuild-ordering note: an in-order rebuild from the dated migrations
-- (lexical filename order == commit order for every file that matters — the
-- one same-day pair with same-second commits, 2026-04-22-renders-table.sql /
-- -renders-fix-rls.sql, only ever touched the now-dropped `renders` table)
-- ends with EVERY live table RLS-ENABLED: the ~12 older create-table files
-- that end with `DISABLE ROW LEVEL SECURITY` all predate
-- 2026-06-28-enable-rls-all-tables.sql (committed 19:28:18 -0400, BEFORE
-- add-created-by.sql 19:39:58, dashboard-tables.sql 20:57:21, and
-- quotes-add-is-test.sql 23:37:02 the same day), and every table created
-- AFTER that migration (jobs, invoices, customers, properties, inventory_*
-- were all created earlier the same day but are also listed in the enable-rls
-- statement; the 6 dashboard tables created later that day ship RLS-enabled
-- from their own CREATE). So a fresh in-order rebuild is safe: no table is
-- left RLS-disabled at the end. The FOOTGUN W2-006 actually flags is
-- different — re-running any ONE of the older create-table files by itself
-- (e.g. re-importing the Thunder catalog per inventory-catalog.sql's own
-- instructions) still re-disables RLS on that single table, because each
-- file was written to be individually re-runnable. See the corrective
-- comment added to 2026-06-28-enable-rls-all-tables.sql.
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

-- Integration + lifecycle + walkthrough-video + payment + status + identity
-- columns (added post-base, in migration date order). All nullable/defaulted
-- so an existing quotes table is patched in place.
alter table quotes
  -- 2026-04-23 integration link columns
  add column if not exists highlevel_contact_id text,
  add column if not exists highlevel_opportunity_id text,
  add column if not exists homeworks_sent_at timestamptz,
  add column if not exists homeworks_webhook_response jsonb,
  add column if not exists customer_approved_at timestamptz,
  add column if not exists approval_snapshot jsonb,
  -- 2026-04-24 quote_sent_at + walkthrough video
  add column if not exists quote_sent_at timestamptz,
  add column if not exists video_kind text,
  add column if not exists video_src text,
  add column if not exists video_poster text,
  add column if not exists video_title text,
  add column if not exists video_duration_sec integer,
  -- 2026-04-30 home.works signed-contract webhook
  add column if not exists homeworks_signed_at timestamptz,
  add column if not exists homeworks_contract_id text,
  -- 2026-06-24 Valor deposit-payment columns (#38)
  add column if not exists valor_order_ref text,
  add column if not exists deposit_amount_usd numeric(10,2),
  add column if not exists deposit_paid_at timestamptz,
  add column if not exists valor_txn_id text,
  add column if not exists valor_vault_token text,
  add column if not exists valor_approval_code text,
  add column if not exists valor_receipt_url text,
  add column if not exists valor_payment_raw jsonb,
  -- 2026-06-24 service_type (#58 Phase 2a): Holiday/Permanent/Event
  -- categorization powering the dashboard per-service sections. text + CHECK
  -- rather than a PG enum so adding values later is a simple ALTER (no
  -- ALTER TYPE dance). Nullable; the app reads NULL as 'holiday' (the legacy
  -- default), and the migration backfills existing rows to 'holiday'.
  add column if not exists service_type text,
  -- 2026-06-25 view receipt (#68): when the customer opens their portal
  -- link, /api/quotes/[id]/view stamps these so the admin table shows a
  -- "Viewed" badge and staff get a GHL email per open. viewed_at = first
  -- open, last_viewed_at = most recent, view_count = total opens.
  add column if not exists viewed_at timestamptz,
  add column if not exists last_viewed_at timestamptz,
  add column if not exists view_count integer not null default 0,
  -- 2026-06-27 status spine + display numbers (#83 Phase 1 Slice A)
  add column if not exists status text,
  add column if not exists decline_reason text,
  add column if not exists quote_number int,
  -- 2026-06-27 GHL pipeline-stage sync durability
  add column if not exists ghl_stage_synced_at timestamptz,
  add column if not exists ghl_sync_error text,
  -- 2026-06-27 approve-notify failure marker
  add column if not exists approval_notify_failed_at timestamptz,
  add column if not exists approval_notify_error text,
  -- customer_id/property_id (#83 Phase 5) are added further down, right
  -- after the customers/properties tables are created — those tables must
  -- exist before quotes can FK-reference them on a fresh DB.
  -- 2026-06-28 actor audit trail (#81/#90)
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  -- 2026-06-28 Test Quote flag (#93) — fully-simulated end-to-end test data
  add column if not exists is_test boolean not null default false,
  -- 2026-07-16 Legacy rebook flag (#155) — quotes migrated from last year's
  -- Jobber data get a slightly different portal + an admin detail line.
  add column if not exists legacy_rebook boolean not null default false;

alter table quotes drop constraint if exists quotes_video_kind_check;
alter table quotes add constraint quotes_video_kind_check
  check (video_kind is null or video_kind in ('youtube', 'mp4'));

alter table quotes drop constraint if exists quotes_service_type_check;
alter table quotes add constraint quotes_service_type_check
  check (service_type is null or service_type in ('holiday', 'permanent', 'event', 'permanent_bistro'));

-- Backfill legacy NULLs to 'holiday' (idempotent).
update quotes set service_type = 'holiday' where service_type is null;

-- Backfill status from existing timestamps (same precedence as deriveStatus()
-- in code). Guarded on status IS NULL so a re-run never clobbers a status a
-- write path has since set.
update quotes
set status = case
  when deposit_paid_at is not null then 'booked'
  when customer_approved_at is not null then 'approved'
  when viewed_at is not null then 'viewed'
  when quote_sent_at is not null then 'sent'
  else 'draft'
end
where status is null;

alter table quotes enable row level security;

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
create index if not exists quotes_valor_order_ref_idx
  on quotes (valor_order_ref) where valor_order_ref is not null;
create index if not exists quotes_valor_txn_id_idx
  on quotes (valor_txn_id) where valor_txn_id is not null;
create index if not exists quotes_ghl_stage_unsynced_idx
  on quotes (quote_sent_at desc) where quote_sent_at is not null and ghl_stage_synced_at is null;
create index if not exists quotes_approval_notify_failed_idx
  on quotes (approval_notify_failed_at desc) where approval_notify_failed_at is not null;
create index if not exists quotes_is_test_idx on quotes (is_test);
-- quotes_customer_id_idx is created later, alongside the customer_id column
-- itself (see the "Quote ⇄ customer/property linkage" block near the
-- properties table — customer_id can't exist until customers does).

-- Display-number sequence (seeded at #1000 so early real customers don't see
-- "#1"). Independent per entity type — job_number_seq / invoice_number_seq
-- below share the one allocate_display_number() RPC.
create sequence if not exists public.quote_number_seq start with 1000;

create unique index if not exists quotes_quote_number_key
  on quotes (quote_number) where quote_number is not null;

-- Per-view event log (customer activity feed, 2026-06-25). One row per
-- customer open of a quote portal — powers the /customers/[id] activity
-- timeline (every view, not just the #68 aggregate). Lifecycle events come
-- from the quotes row. `kind` (2026-06-25 same-day follow-up): 'viewed'
-- (read receipt) or 'interested' (the customer hovered/tapped Approve
-- without approving — a hot-lead signal).
create table if not exists quote_view_events (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid not null references quotes(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  kind text not null default 'viewed'
);
alter table quote_view_events
  add column if not exists kind text not null default 'viewed';
alter table quote_view_events drop constraint if exists quote_view_events_kind_check;
alter table quote_view_events add constraint quote_view_events_kind_check
  check (kind in ('viewed', 'interested'));
alter table quote_view_events enable row level security;
create index if not exists quote_view_events_quote_idx
  on quote_view_events (quote_id, viewed_at desc);


-- ---------------------------------------------------------------------
-- 2. photo_corrections — REMOVED (S13, 2026-06-25-drop-photo-corrections.sql)
--    The legacy corrections system was retired (superseded by the
--    training_examples few-shot library). Nothing in the app writes or
--    reads it anymore. Do not recreate.
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 3. renders — REMOVED (task #36, 2026-06-12-drop-renders.sql)
--    The Gemini/AI render pipeline was fully torn down; the portal hero is
--    the live Konva design (task #27) now. If the `renders` STORAGE BUCKET
--    still exists, delete it by hand in the Supabase UI — buckets are
--    managed by the Storage API, not plain SQL. Do not recreate the table.
-- ---------------------------------------------------------------------


-- ---------------------------------------------------------------------
-- 4. training_houses
--    ⚠️ Like reference_assets (see 2026-05-29-reference-assets-create.sql),
--    this table's BASE shape predates the migrations/ directory — it was
--    created by hand in Supabase and was never captured in a migration, so
--    no dated file creates it or several of its columns (scale_anchor,
--    didnt_install, ai_failure_notes, cost_materials, cost_labor_hours,
--    revenue, wreath_detections, spritzer_detections — confirmed live via
--    the StoredTrainingHouse type in src/lib/training.ts, present since the
--    repo's initial commit). This CREATE TABLE reconstructs the full shape
--    from that type so a fresh rebuild doesn't 500 on save/list; only the
--    columns below marked with a migration date are actually migration-
--    tracked (audit #110 wave 2, W2-007 follow-up).
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
  wreath_detections jsonb not null default '[]'::jsonb,
  spritzer_detections jsonb not null default '[]'::jsonb,
  spritzers jsonb not null default '[]'::jsonb,
  wreaths jsonb not null default '[]'::jsonb,
  garland jsonb not null default '[]'::jsonb,
  -- Not migration-tracked (pre-dates migrations/; see the note above).
  scale_anchor text,
  didnt_install text,
  ai_failure_notes text,
  cost_materials numeric,
  cost_labor_hours numeric,
  revenue numeric
);

-- Garland bounding-box detections + c9 polyline (2026-04-22, nullable).
alter table training_houses
  add column if not exists garland_detections jsonb,
  add column if not exists c9_lines jsonb;

-- Stake Lighting columns (2026-06-26) — parallel of the winter_wonderland_*
-- columns for the independent staked-ground-run category.
alter table training_houses
  add column if not exists stake_lighting_footage    numeric(10,2),
  add column if not exists stake_lighting_difficulty text,
  add column if not exists stake_lines               jsonb;

-- Not migration-tracked — see the table-header note. Idempotent guard so this
-- file stays safe to re-run even though no dated migration owns these.
alter table training_houses
  add column if not exists wreath_detections jsonb not null default '[]'::jsonb,
  add column if not exists spritzer_detections jsonb not null default '[]'::jsonb,
  add column if not exists scale_anchor text,
  add column if not exists didnt_install text,
  add column if not exists ai_failure_notes text,
  add column if not exists cost_materials numeric,
  add column if not exists cost_labor_hours numeric,
  add column if not exists revenue numeric;

alter table training_houses enable row level security;
create index if not exists training_houses_created_at_idx on training_houses (created_at desc);
create index if not exists training_houses_address_idx on training_houses (address);


-- ---------------------------------------------------------------------
-- 5. reference_assets
--    Product close-ups (spritzer/wreath/garland) injected into Claude calls
--    as few-shot context. Reached via the service-role client; RLS enabled
--    with no policies (#90). (See referenceAssets.ts.)
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

alter table reference_assets enable row level security;
create index if not exists reference_assets_created_at_idx on reference_assets (created_at desc);
create index if not exists reference_assets_asset_type_idx on reference_assets (asset_type);


-- ---------------------------------------------------------------------
-- 6. designs  (design-tool integration, Path B — task #27 Phase 1)
--    One editable on-photo light design. The `scene` jsonb is the design
--    tool's Scene shape (yardsticks + items + brightness). A design is an
--    INDEPENDENT record with its own id and an OPTIONAL link to a quote, so it
--    can exist before a quote is saved (the builder creates it when the Street
--    View photo is pulled) and even with no quote at all (future standalone
--    use). The quote link is set when the operator clicks "Calculate Quote".
--    Reached via the service-role client (server routes); RLS enabled with no
--    policies (#90).
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
-- staff's final satellite measurement polylines.
alter table designs
  add column if not exists seed_analysis jsonb,
  add column if not exists satellite_path text,
  add column if not exists satellite_w integer,
  add column if not exists satellite_h integer,
  add column if not exists satellite_feet_per_pixel numeric,
  add column if not exists satellite_lines jsonb,
  -- 2026-06-28 actor audit trail (#81/#90)
  add column if not exists created_by uuid references auth.users(id) on delete set null,
  -- 2026-07-02 multi-image quoting (#13): extra street photos on a design.
  -- One design still owns ONE base photo (photo_path); extras live in a
  -- JSONB array of { id, path, w, h, title? } whose storage objects sit
  -- under the same `{designId}/` prefix (extra-<id>.<ext>).
  add column if not exists extra_photos jsonb,
  -- 2026-07-02 a staff title for the BASE photo (renameable "Photo 1" tab,
  -- like the extras' own titles). Nullable — null renders as "Photo 1".
  add column if not exists photo_title text;

alter table designs enable row level security;

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
-- extra photos + custom-item images). Private; reads go through service-role
-- signed URLs.
insert into storage.buckets (id, name, public)
values ('designs', 'designs', false)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- 7. training_examples  (#8 Stage A — scene-based AI training snapshots)
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

alter table training_examples enable row level security;

create index if not exists training_examples_created_at_idx
  on training_examples (created_at desc);

-- Upsert semantics: a quote keeps at most ONE example per source — re-sending
-- or re-saving REPLACES that snapshot (the latest staff-confirmed state wins).
-- NOT partial: PostgREST's ON CONFLICT can't infer a partial unique index
-- (42P10); NULL quote_ids are distinct under unique semantics anyway.
create unique index if not exists training_examples_quote_source_uniq
  on training_examples (quote_id, source);

-- #8 Stage B — image-embedding similarity retrieval (2026-06-15). Each
-- example's street photo is embedded (Voyage voyage-multimodal-3.5, 1024
-- dims — under pgvector's 2000-dim index ceiling; no ANN index needed at
-- this scale). The match RPC returns the nearest non-excluded examples by
-- cosine distance. App degrades to recency when the embedding is null, so
-- this is additive.
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


-- ---------------------------------------------------------------------
-- 8. app_settings  (task #32 Phase 1)
--    A simple key→JSON store for APP-WIDE settings (one config for the whole
--    YLL business), mirroring the design tool's `app_settings` table. Keys:
--    'colors' → BulbColor[], 'render' → RenderSettings, 'defaults' →
--    ToolDefaults. Reached only via the service-role client; RLS enabled
--    with no policies (#90).
-- ---------------------------------------------------------------------
create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table app_settings enable row level security;

create or replace function app_settings_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists app_settings_updated_at_trigger on app_settings;
create trigger app_settings_updated_at_trigger
  before update on app_settings
  for each row execute function app_settings_set_updated_at();


-- ---------------------------------------------------------------------
-- 9. custom_uploads  (task #32 Phase 3)
--    Staff-uploaded item graphics ("custom" items) that can be placed on ANY
--    design (a global library, not per-design). The image bytes live in the
--    PUBLIC `custom-uploads` Storage bucket; this table is the library index.
--    Writes go through the service-role client; the table itself is
--    service-role-only. RLS enabled with no policies (#90).
-- ---------------------------------------------------------------------
create table if not exists custom_uploads (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  path text not null,                                  -- object path in the custom-uploads bucket
  created_at timestamptz not null default now()
);

alter table custom_uploads enable row level security;
create index if not exists custom_uploads_created_at_idx on custom_uploads (created_at desc);

-- Public bucket for the custom-item graphics (anonymous read is automatic for
-- public buckets; uploads/deletes go through the service-role client).
insert into storage.buckets (id, name, public)
values ('custom-uploads', 'custom-uploads', true)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- 10. inventory_catalog  (#82 Slice 1a)
--     The raw vendor catalog, imported from Thunder's CSV. Vendor-sourced
--     columns are re-seeded on every import; OPERATOR columns
--     (yll_category, locked) are never touched by import. Reached only via
--     the service-role client; RLS enabled with no policies (#90).
-- ---------------------------------------------------------------------
create table if not exists inventory_catalog (
  sku            text primary key,
  name           text not null,
  category       text not null default 'Uncategorized',
  yll_category   text,
  color          text,
  size           text,
  wholesale_cost numeric,
  needs_adapter  boolean not null default false,
  bag_ct         integer,
  case_ct        integer,
  locked         boolean not null default false,
  updated_at     timestamptz not null default now()
);

alter table inventory_catalog enable row level security;

create or replace function inventory_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists inventory_catalog_updated_at_trigger on inventory_catalog;
create trigger inventory_catalog_updated_at_trigger
  before update on inventory_catalog
  for each row execute function inventory_set_updated_at();


-- ---------------------------------------------------------------------
-- 11. inventory_on_hand  (#82 Slice 1c)
--     One row per stocked SKU. `sku` logically refs inventory_catalog.sku
--     (the app only adds SKUs picked from the catalog). RLS enabled with no
--     policies, matching inventory_catalog.
-- ---------------------------------------------------------------------
create table if not exists inventory_on_hand (
  sku              text primary key,
  on_hand_qty      integer not null default 0,
  reorder_point    integer not null default 0,
  storage_location text,
  updated_at       timestamptz not null default now()
);

alter table inventory_on_hand enable row level security;

drop trigger if exists inventory_on_hand_updated_at_trigger on inventory_on_hand;
create trigger inventory_on_hand_updated_at_trigger
  before update on inventory_on_hand
  for each row execute function inventory_set_updated_at();


-- ---------------------------------------------------------------------
-- 12. customers  (#83 Phase 5)
--     A stable customer identity. `match_key` is the computed dedup key
--     (hl:<id> | email:<lower> | phone:<digits> | name:<lower>) — UNIQUE so
--     find-or-create is race-safe. Reached only via the service-role client;
--     RLS enabled with no policies (#90).
-- ---------------------------------------------------------------------
create table if not exists public.customers (
  id            uuid primary key default gen_random_uuid(),
  match_key     text unique,
  hl_contact_id text,
  name          text,
  email         text,
  phone         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.customers enable row level security;

create index if not exists customers_hl_contact_id_idx
  on public.customers (hl_contact_id) where hl_contact_id is not null;
create index if not exists customers_email_idx
  on public.customers (email) where email is not null;

create or replace function public.customers_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists customers_updated_at_trigger on public.customers;
create trigger customers_updated_at_trigger
  before update on public.customers
  for each row execute function public.customers_set_updated_at();


-- ---------------------------------------------------------------------
-- 13. properties  (#83 Phase 5)
--     One-or-more service addresses per customer. `address_key` is the
--     normalized address so trivial formatting differences collapse to ONE
--     property; UNIQUE per customer. lat/lng reserved for a future geocode.
--     RLS enabled with no policies, matching customers.
-- ---------------------------------------------------------------------
create table if not exists public.properties (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references public.customers(id) on delete cascade,
  address      text,
  address_key  text not null,
  lat          double precision,
  lng          double precision,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (customer_id, address_key)
);

alter table public.properties enable row level security;

create index if not exists properties_customer_id_idx
  on public.properties (customer_id);

drop trigger if exists properties_updated_at_trigger on public.properties;
create trigger properties_updated_at_trigger
  before update on public.properties
  for each row execute function public.customers_set_updated_at();

-- ── Quote ⇄ customer/property linkage (#83 Phase 5) ─────────────────────────
-- Quotes reference the stable customer + property. Nullable: a quote with no
-- identity at all (anonymous test entry) stays unlinked. ON DELETE SET NULL
-- so removing a customer/property never cascade-deletes the quote history.
-- Added HERE (not in quotes' own CREATE TABLE / column block in section 1)
-- because customers/properties must exist first for the FK to resolve on a
-- fresh DB — this mirrors the real migration order (customers-properties.sql
-- creates both tables, then ALTERs quotes, in that order).
alter table public.quotes
  add column if not exists customer_id uuid references public.customers(id) on delete set null;
alter table public.quotes
  add column if not exists property_id uuid references public.properties(id) on delete set null;

create index if not exists quotes_customer_id_idx
  on public.quotes (customer_id) where customer_id is not null;


-- ---------------------------------------------------------------------
-- 14. jobs  (#83 billing + #82 fulfillment — SHARED table for both epics)
--     The deposit-paid Valor webhook is the SINGLE creator (idempotent on
--     quote_id); #82's inventory side EXTENDS the same row (fulfillment_stage
--     + design_id → materials). RLS enabled with no policies (#90).
-- ---------------------------------------------------------------------
create sequence if not exists public.job_number_seq start with 1000;

create table if not exists public.jobs (
  id            uuid primary key default gen_random_uuid(),

  -- Human-friendly sequential display number (Job #1000, …) allocated from
  -- job_number_seq at creation. Job ID (uuid) ≠ Quote ID — own entity.
  job_number    int unique,

  -- From-Quote link: which quote this job was created from. The job
  -- snapshots the quote's line items at creation. ON DELETE CASCADE: deleting
  -- a quote tears down its job (and its invoice via the invoices→jobs
  -- cascade).
  quote_id      uuid references public.quotes(id) on delete cascade,

  -- The live editable design (#27) this job draws materials from (#82:
  -- design_id → scene → materials projection). Nullable — set from the
  -- quote's design at creation when present.
  design_id     uuid,

  -- Stable customer/property identity (#83 Phase 5).
  customer_id   uuid,
  property_id   uuid,

  -- one_off (seasonal) | permanent (Glow365 recurring billing deferred).
  -- Carried from the quote's service_type at creation.
  type          text not null default 'one_off',

  -- #83 BILLING lifecycle status: to_schedule → scheduled → installed →
  -- requires_invoicing → done (+ cancelled). Free text (canonical set
  -- enforced in code: src/lib/jobs.ts JOB_STATUSES).
  status        text not null default 'to_schedule',

  -- #82 owns this — the materials/fulfillment Kanban axis (a DIFFERENT board
  -- from the dashboard's Quotes WorkflowBoard). NULL when unmanaged by #82.
  fulfillment_stage text,

  -- Snapshot of the quote's priced line items at creation (jsonb). The job
  -- is a snapshot, not a live view of the quote.
  line_items    jsonb,

  -- Install date — synced from home.works later (#84).
  install_date  date,

  -- When the job was marked done/installed-complete (#83 invoice trigger).
  completed_at  timestamptz,

  -- #82 Phase 2 (stock loop, 2026-06-27): records WHEN a job's materials
  -- were prepped and its on-hand stock decremented, so the decrement fires
  -- exactly once per job (idempotent "prepare"). NULL = not yet prepped.
  stock_decremented_at timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

alter table public.jobs enable row level security;

-- One job per quote — the auto-create is idempotent in code, but this guards
-- against a concurrent double-insert at the DB level too. Partial: only the
-- rows actually linked to a quote.
create unique index if not exists jobs_quote_id_key
  on public.jobs (quote_id)
  where quote_id is not null;

create index if not exists jobs_created_at_idx on public.jobs (created_at desc);
create index if not exists jobs_status_idx on public.jobs (status);

create or replace function public.jobs_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists jobs_updated_at_trigger on public.jobs;
create trigger jobs_updated_at_trigger
  before update on public.jobs
  for each row execute function public.jobs_set_updated_at();

-- allocate_display_number RPC — SECURITY DEFINER, locked to the known
-- sequence allowlist (quote/job/invoice) so it can't bump an arbitrary
-- relation. Defined here in its FINAL form (the invoices migration below is
-- the last CREATE OR REPLACE that extended it); quotes/jobs/invoices all
-- call the same function.
create or replace function public.allocate_display_number(seq_name text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
begin
  if seq_name not in ('quote_number_seq', 'job_number_seq', 'invoice_number_seq') then
    raise exception 'allocate_display_number: unknown sequence %', seq_name;
  end if;
  return nextval(seq_name::regclass);
end;
$$;


-- ---------------------------------------------------------------------
-- 15. invoices  (#83 Phase 3 — the money tail of the Jobber-flow)
--     Auto-created when a job is marked installed/complete. The FULL total
--     with the already-paid deposit applied as a payment → the remaining
--     balance. RLS enabled with no policies (#90).
-- ---------------------------------------------------------------------
create sequence if not exists public.invoice_number_seq start with 1000;

create table if not exists public.invoices (
  id              uuid primary key default gen_random_uuid(),

  -- Human-friendly sequential display number (Invoice #1000, …).
  invoice_number  int unique,

  -- The job this invoice bills for (one invoice per job). From-Quote link
  -- kept too for direct reference. ON DELETE CASCADE on both.
  job_id          uuid references public.jobs(id) on delete cascade,
  quote_id        uuid references public.quotes(id) on delete cascade,

  -- Stable customer identity (#83 Phase 5). Carried from the job at creation.
  customer_id     uuid,

  -- Money breakdown, snapshotted from the quote's priced result at creation.
  subtotal        numeric(10, 2) not null default 0,
  discount        numeric(10, 2) not null default 0,
  tax             numeric(10, 2) not null default 0,
  total           numeric(10, 2) not null default 0,

  -- The deposit ALREADY PAID at booking (quotes.deposit_amount_usd) applied
  -- as a payment. balance = max(0, total − deposit_applied). credit_note is
  -- the overpayment (a MANUAL Valor refund, surfaced here; no refund
  -- integration).
  deposit_applied numeric(10, 2) not null default 0,
  balance         numeric(10, 2) not null default 0,
  credit_note     numeric(10, 2) not null default 0,

  -- Manual tax-override (rare exemptions). When true the math zeroes tax.
  tax_overridden  boolean not null default false,

  -- Lifecycle: draft → awaiting_payment → paid (+ cancelled). Free text
  -- (canonical set enforced in code: src/lib/invoiceStatus.ts).
  status          text not null default 'draft',

  -- Set when the balance is collected (Phase 3 collection). Nullable until.
  valor_balance_txn_id text,
  valor_receipt_url    text,

  created_at      timestamptz not null default now(),
  paid_at         timestamptz,
  updated_at      timestamptz not null default now()
);

alter table public.invoices enable row level security;

-- One invoice per job — createInvoiceFromJob is idempotent in code; this
-- guards a concurrent double-insert at the DB level. Partial: only rows
-- linked to a job.
create unique index if not exists invoices_job_id_key
  on public.invoices (job_id)
  where job_id is not null;

create index if not exists invoices_created_at_idx on public.invoices (created_at desc);
create index if not exists invoices_status_idx on public.invoices (status);

create or replace function public.invoices_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists invoices_updated_at_trigger on public.invoices;
create trigger invoices_updated_at_trigger
  before update on public.invoices
  for each row execute function public.invoices_set_updated_at();


-- =====================================================================
-- Dashboard tables (#58) — 6 net-new tables behind the /inbox tab.
--
-- ⚠️ DELIBERATE DIVERGENCE FROM THE HOUSE CONVENTION ABOVE. The tables in
-- sections 1-15 ship with RLS ENABLED and NO policies, reached only via the
-- service-role client. These dashboard tables ship with RLS ENABLED +
-- EXPLICIT policies from day one (the dashboard's whole premise is locking
-- PII down). Authenticated operators get SELECT/UPDATE on the three
-- operator-facing tables (dashboard_contacts, inbox_items, follow_ups) and
-- SELECT-only on the append-only audit log (dashboard_activity); all INSERTs
-- and all token/cursor access go through the service-role client.
-- integration_tokens + sync_cursors are deny-all to authenticated.
-- service_role bypasses RLS regardless; the explicit policy is documentation
-- + intent.
-- =====================================================================

-- citext gives case-insensitive email matching at the DB layer.
create extension if not exists citext;

-- ---------------------------------------------------------------------
-- 16. dashboard_contacts — one card per human, collapsed across channels.
-- ---------------------------------------------------------------------
create table if not exists public.dashboard_contacts (
  id                uuid primary key default gen_random_uuid(),
  display_name      text,
  primary_email     citext,
  primary_phone     text,                              -- E.164, e.g. +16315551234
  emails            citext[] not null default '{}',    -- all known emails (append on match)
  phones            text[]   not null default '{}',    -- all known phones (E.164)
  ghl_contact_id    text unique,                       -- canonical id when known (multiple NULLs allowed)
  -- Loose pointer to public.customers(id). Intentionally NOT a FK: avoids
  -- coupling this RLS-enabled table to the customers table and tolerates
  -- ingest before a customers row exists. Resolved/joined in code.
  quote_customer_id uuid,
  assigned_to       uuid references auth.users(id) on delete set null,  -- NULL = unclaimed (shared queue)
  tags              text[] not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Identity-resolution lookups (identity.ts match order: ghl_contact_id → email → phone).
create index if not exists dashboard_contacts_emails_gin on public.dashboard_contacts using gin (emails);
create index if not exists dashboard_contacts_phones_gin on public.dashboard_contacts using gin (phones);
create index if not exists dashboard_contacts_primary_email_idx
  on public.dashboard_contacts (primary_email) where primary_email is not null;
create index if not exists dashboard_contacts_assigned_to_idx
  on public.dashboard_contacts (assigned_to) where assigned_to is not null;

alter table public.dashboard_contacts enable row level security;
drop policy if exists dashboard_contacts_select_auth   on public.dashboard_contacts;
drop policy if exists dashboard_contacts_update_auth   on public.dashboard_contacts;
drop policy if exists dashboard_contacts_service_all   on public.dashboard_contacts;
create policy dashboard_contacts_select_auth on public.dashboard_contacts
  for select to authenticated using (true);
create policy dashboard_contacts_update_auth on public.dashboard_contacts
  for update to authenticated using (true) with check (true);
create policy dashboard_contacts_service_all on public.dashboard_contacts
  for all to service_role using (true) with check (true);


-- ---------------------------------------------------------------------
-- 17. inbox_items — the unified feed (ONE row per conversation, not per message).
-- ---------------------------------------------------------------------
create table if not exists public.inbox_items (
  id                   uuid primary key default gen_random_uuid(),
  contact_id           uuid references public.dashboard_contacts(id) on delete cascade,
  source               text not null,        -- ghl | gmail | quotetool | homeworks
  external_id          text not null,        -- conversation id / gmail thread id / quote id
  source_message_id    text,                 -- last message id (drives GHL mark-read on Handled)
  event_type           text,                 -- e.g. 'message' | 'new_quote'
  direction            text,                 -- inbound | outbound (last message)
  channel              text,                 -- sms | email | call | fb | ig | app
  last_message_at      timestamptz,
  preview              text,
  subject              text,
  status               text not null default 'unresponded',  -- unresponded | handled | dismissed | completed
  handled_by           uuid references auth.users(id) on delete set null,  -- NULL when system auto-resolved
  handled_at           timestamptz,
  handled_channel_sync jsonb,                -- per-channel write-back outcome (mark-read/label/opportunity)
  escalation_level     int   not null default 0,    -- 0 none | 1 amber | 2 red | 3 EOD
  notified_levels      int[] not null default '{}', -- escalation levels already emailed (no double-send)
  raw                  jsonb,                -- the source payload (audit/debug)
  -- 2026-06-30 snooze/"Followed": followed items hide from the open list and
  -- reappear only on a genuinely-newer message. Orthogonal to status.
  followed_up_at       timestamptz,
  -- 2026-06-30 triage v1: 'lead' | 'automated' (NULL = unclassified, treated
  -- as 'lead') + the quote $ total for quotetool items (NULL elsewhere).
  lead_kind            text,
  quote_value          numeric,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- Idempotent upsert key: re-ingesting the same conversation updates the row.
  constraint inbox_items_source_external_id_key unique (source, external_id),
  constraint inbox_items_source_check check (source in ('ghl','gmail','quotetool','homeworks'))
);

alter table public.inbox_items drop constraint if exists inbox_items_status_check;
alter table public.inbox_items add constraint inbox_items_status_check
  check (status in ('unresponded','handled','dismissed','completed'));

-- The /inbox list (open items, newest first) + the escalation cron scan.
create index if not exists inbox_items_status_last_message_idx
  on public.inbox_items (status, last_message_at desc);
create index if not exists inbox_items_status_escalation_idx
  on public.inbox_items (status, escalation_level);
create index if not exists inbox_items_contact_id_idx
  on public.inbox_items (contact_id);
create index if not exists inbox_items_followed_up_at_idx
  on public.inbox_items (followed_up_at)
  where followed_up_at is not null;
-- Open-list filter is (status='unresponded' AND lead_kind …); this index serves it.
create index if not exists inbox_items_status_lead_kind_idx
  on public.inbox_items (status, lead_kind, last_message_at desc);

alter table public.inbox_items enable row level security;
drop policy if exists inbox_items_select_auth on public.inbox_items;
drop policy if exists inbox_items_update_auth on public.inbox_items;
drop policy if exists inbox_items_service_all on public.inbox_items;
create policy inbox_items_select_auth on public.inbox_items
  for select to authenticated using (true);
create policy inbox_items_update_auth on public.inbox_items
  for update to authenticated using (true) with check (true);
create policy inbox_items_service_all on public.inbox_items
  for all to service_role using (true) with check (true);


-- ---------------------------------------------------------------------
-- 18. follow_ups — "due today" reminders (system-created + manual).
-- ---------------------------------------------------------------------
create table if not exists public.follow_ups (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid references public.dashboard_contacts(id) on delete cascade,
  inbox_item_id uuid references public.inbox_items(id) on delete set null,
  due_at        timestamptz not null,                 -- "due today" evaluated in America/New_York
  reason        text,                                 -- e.g. 'quote_sent_no_reply'
  assigned_to   uuid references auth.users(id) on delete set null,
  status        text not null default 'pending',      -- pending | done | dismissed
  created_by    uuid references auth.users(id) on delete set null,  -- NULL when system-created
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint follow_ups_status_check check (status in ('pending','done','dismissed')),
  -- One system follow-up per (item, reason): makes ensureFollowUp idempotent
  -- at the DB layer. NULLs are distinct in Postgres, so manual follow-ups
  -- (null inbox_item_id) are not constrained by this.
  constraint follow_ups_item_reason_key unique (inbox_item_id, reason)
);

create index if not exists follow_ups_status_due_at_idx on public.follow_ups (status, due_at);
create index if not exists follow_ups_contact_id_idx    on public.follow_ups (contact_id);

alter table public.follow_ups enable row level security;
drop policy if exists follow_ups_select_auth on public.follow_ups;
drop policy if exists follow_ups_update_auth on public.follow_ups;
drop policy if exists follow_ups_service_all on public.follow_ups;
create policy follow_ups_select_auth on public.follow_ups
  for select to authenticated using (true);
create policy follow_ups_update_auth on public.follow_ups
  for update to authenticated using (true) with check (true);
create policy follow_ups_service_all on public.follow_ups
  for all to service_role using (true) with check (true);


-- ---------------------------------------------------------------------
-- 19. dashboard_activity — append-only audit (who handled/assigned/escalated what).
-- ---------------------------------------------------------------------
create table if not exists public.dashboard_activity (
  id            uuid primary key default gen_random_uuid(),
  actor         text,                                 -- auth.users id (as text) or 'system'
  action        text not null,                        -- ingested|assigned|handled|reopened|escalated|dismissed|writeback_ok|writeback_failed
  inbox_item_id uuid references public.inbox_items(id) on delete set null,
  contact_id    uuid references public.dashboard_contacts(id) on delete set null,
  detail        jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists dashboard_activity_inbox_item_idx on public.dashboard_activity (inbox_item_id);
create index if not exists dashboard_activity_created_at_idx on public.dashboard_activity (created_at desc);

alter table public.dashboard_activity enable row level security;
drop policy if exists dashboard_activity_select_auth on public.dashboard_activity;
drop policy if exists dashboard_activity_service_all on public.dashboard_activity;
create policy dashboard_activity_select_auth on public.dashboard_activity
  for select to authenticated using (true);
create policy dashboard_activity_service_all on public.dashboard_activity
  for all to service_role using (true) with check (true);


-- ---------------------------------------------------------------------
-- 20. integration_tokens — Gmail OAuth (server-only; deny-all to authenticated).
-- ---------------------------------------------------------------------
create table if not exists public.integration_tokens (
  id                uuid primary key default gen_random_uuid(),
  provider          text  not null,                   -- 'gmail'
  account_email     citext not null,
  refresh_token_enc text,                             -- encrypted at rest (Vault/pgcrypto)
  watch_history_id  text,
  watch_expiration  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint integration_tokens_provider_account_key unique (provider, account_email)
);

alter table public.integration_tokens enable row level security;
drop policy if exists integration_tokens_service_all on public.integration_tokens;
create policy integration_tokens_service_all on public.integration_tokens
  for all to service_role using (true) with check (true);


-- ---------------------------------------------------------------------
-- 21. sync_cursors — per-source incremental state + health (powers "synced
--     12s ago" and the escalation watchdog). Server-only; deny-all to
--     authenticated.
-- ---------------------------------------------------------------------
create table if not exists public.sync_cursors (
  source       text primary key,                      -- ghl | gmail | quotetool | escalate
  cursor       jsonb,                                  -- e.g. { historyId } / { lastConvDate }
  last_run_at  timestamptz,
  last_status  text,                                   -- ok | error
  last_error   text,
  updated_at   timestamptz not null default now()
);

alter table public.sync_cursors enable row level security;
drop policy if exists sync_cursors_service_all on public.sync_cursors;
create policy sync_cursors_service_all on public.sync_cursors
  for all to service_role using (true) with check (true);

-- updated_at triggers for the dashboard tables (mirrors customers_set_updated_at).
create or replace function public.dashboard_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists dashboard_contacts_updated_at  on public.dashboard_contacts;
create trigger dashboard_contacts_updated_at  before update on public.dashboard_contacts
  for each row execute function public.dashboard_set_updated_at();

drop trigger if exists inbox_items_updated_at on public.inbox_items;
create trigger inbox_items_updated_at before update on public.inbox_items
  for each row execute function public.dashboard_set_updated_at();

drop trigger if exists follow_ups_updated_at on public.follow_ups;
create trigger follow_ups_updated_at before update on public.follow_ups
  for each row execute function public.dashboard_set_updated_at();

drop trigger if exists integration_tokens_updated_at on public.integration_tokens;
create trigger integration_tokens_updated_at before update on public.integration_tokens
  for each row execute function public.dashboard_set_updated_at();

drop trigger if exists sync_cursors_updated_at on public.sync_cursors;
create trigger sync_cursors_updated_at before update on public.sync_cursors
  for each row execute function public.dashboard_set_updated_at();
