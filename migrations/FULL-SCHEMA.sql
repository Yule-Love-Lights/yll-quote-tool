-- =====================================================================
-- AI QUOTE TOOL — full canonical schema. Idempotent; safe to re-run.
-- Paste into the Supabase SQL Editor and click Run.
--
-- GENERATED (audit #110 wave 2, finding W2-007): this file is produced by
-- reconciling ALL 83 dated migrations/*.sql files IN DATE ORDER (creates,
-- alters, drops, RLS enable/disable applied in sequence) into one canonical
-- end-state schema. It supersedes running db/schema.sql + the individual
-- dated migrations separately (CREATE ... IF NOT EXISTS on a fresh DB; the
-- ADD COLUMN IF NOT EXISTS / DROP-then-CREATE statements patch an existing
-- one). The dated migrations remain the append-only source of truth for
-- HOW the schema got here; this file is WHERE it landed.
--
-- Regenerated: 2026-08-16 (ledger row 282), reconciling every dated migration
-- through 2026-08-16-crew-members-auth-user-id.sql (81 files). A second pass
-- 2026-08-18 folded in job_assignments (82 files, 38 live tables) — recorded
-- here because the FIRST version of this note said 81/08-16 while line 6 said
-- 82, i.e. the exact hand-patch-without-updating-the-changelog drift row 282
-- existed to end. The counts on line 6 and the roster below are the numbers to
-- trust; re-derive them rather than incrementing by hand.
-- 2026-08-19-quotes-browsing-selection.sql (ledger row 239) folded in the
-- SAME PR that added the migration (83 files, still 38 live tables — an
-- ADD COLUMN on the existing quotes table, not a new table). Row 315
-- verified the header count against a fresh `ls migrations/*.sql` rather
-- than trusting either number, per the "re-derive, don't hand-increment"
-- line above.
-- 2026-08-24-jobs-stock-deductions-snapshot.sql (row 325, ADD COLUMN on the
-- existing jobs table) and 2026-08-24-inventory-orders-enable-rls.sql (row
-- 329, RLS enable on the existing inventory_orders table) both folded in the
-- SAME PR that added them (94 files per a fresh `ls migrations/*.sql`, still
-- 38 live tables — neither adds a new table). Both migrations are UNAPPLIED
-- to prod as of that PR — see each one's own header + this file's
-- inventory_orders posture note for why.
-- WHY THIS PASS EXISTED: the S58 post-close six-lens review (mislabelled S59 until the 2026-08-19 correction) found this file no longer was
-- what its own header claimed. It said "64 dated migrations" and "30 LIVE"
-- tables while 81 migrations and 37 live tables existed, and TWO tables
-- (archive_photos, site_submissions) were absent from the file entirely — so
-- running it on a fresh project did NOT reproduce prod. Root cause was
-- incremental hand-patching, one table per PR, which is how a canonical file
-- drifts while looking maintained. Fixed by re-deriving the roster and the
-- counts from the migrations themselves rather than patching one more table in.
-- Verification for the next regen: the roster below is reproducible by scanning
-- `create table [if not exists] [public.]<name>` across db/schema.sql plus every
-- dated migration in date order, minus `drop table` tombstones. Note two
-- creation styles coexist — older tables are unqualified (`create table if not
-- exists quotes`), newer ones are schema-qualified (`public.jobs`) — so any
-- audit script must match BOTH or it will silently under-count, as a first pass
-- at this regen did.
--
-- Previous refresh: 2026-08-03 @ commit bf2ed09, through
-- 2026-08-03-dashboard-activity-action-idx.sql (64 files, ledger #188).
--
-- Tables (38 LIVE + 2 REMOVED tombstones below; RLS ENABLED on all 38 live
-- ones as of 2026-08-24-inventory-orders-enable-rls.sql (ledger row 329) —
-- #90 defense in depth. inventory_orders was the one exception (RLS
-- DISABLED) from its 2026-07-06 creation until that fix; see its own posture
-- bullet below for the history and the "UNAPPLIED to prod" caveat. Three RLS
-- postures coexist by design (see migrations/2026-06-28-dashboard-tables.sql
-- header + the W2-006 note in 2026-06-28-enable-rls-all-tables.sql):
--   * "classic" PII/service-role-only tables (quotes, designs, training_houses,
--     reference_assets, training_examples, app_settings, custom_uploads,
--     inventory_catalog, inventory_on_hand, inventory_orders, customers,
--     properties, jobs, invoices, quote_view_events,
--     permanent_training_examples, referrals, website_leads,
--     self_serve_estimates, self_serve_analyzer_budget, job_material_actuals,
--     bot_pending_actions, bot_audit_log, bot_users):
--     RLS enabled with NO policies. Every path uses the service-role client,
--     which bypasses RLS — anon/authenticated get nothing.
--   * dashboard tables (dashboard_contacts, inbox_items, follow_ups,
--     dashboard_activity, integration_tokens, sync_cursors): RLS enabled WITH
--     explicit policies — authenticated operators get SELECT (+UPDATE on the
--     three operator tables); integration_tokens/sync_cursors are deny-all to
--     authenticated; service_role gets ALL on every table (bypasses RLS
--     anyway; policy exists for documentation/intent).
--   * inventory_orders (added 2026-07-06-inventory-orders.sql, table #21
--     below) shipped RLS DISABLED entirely — NOT "enabled with no policies"
--     like its inventory_catalog / inventory_on_hand siblings, despite that
--     migration's own header comment claiming it "matches" them. That claim
--     was stale: inventory_catalog and inventory_on_hand were both swept to
--     RLS-ENABLED by 2026-06-28-enable-rls-all-tables.sql, which predates
--     inventory_orders' creation by over a week and so never touched it.
--     Flagged as a live discrepancy at the 2026-08-03 regen (ledger #188),
--     then fixed by row 329 (2026-08-24-inventory-orders-enable-rls.sql):
--     every real consumer (src/lib/inventory/orders.ts) already used the
--     service-role client exclusively, so RLS-enabled-with-no-policies
--     changes no code path and folds it into the "classic" bucket above. As
--     of the PR that added that migration it is UNAPPLIED to prod (an RLS
--     change on an existing table is ask-first per AGENTS.md, not
--     auto-applied) — this file describes the schema once it IS applied.
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
--   21. inventory_orders    — on-order ledger for the supplier auto PO (P8/
--       #110 W7-002; 2026-07-06). RLS ENABLED, no policies (row 329,
--       2026-08-24) — see the posture note above.
--   22. permanent_training_examples — the PERMANENT-lighting AI training
--       loop, satellite-primary embedding + retrieval (#141; 2026-07-08)
--   23. referrals           — referral program ledger: link/mention
--       attribution, redemption columns (2026-07-11), 2yr credit expiry
--       (2026-07-11) (ledger #41; 2026-07-10)
--   24. website_leads       — WordPress quote-request form intake + GHL sync
--       retry queue/bookkeeping (2026-07-11, retry cols 2026-07-12)
--   25. self_serve_estimates — accuracy telemetry for the public self-serve
--       estimator (2026-07-19)
--   26. self_serve_analyzer_budget — daily aggregate spend cap (all-IPs) for
--       the self-serve estimator (2026-07-20)
--   27. job_material_actuals — field-reported actual material usage per job,
--       text-ops bot Phase 2 (#168; 2026-07-22)
--   28. bot_pending_actions — text-ops bot confirm-yes gate memory (#168;
--       2026-07-22)
--   29. bot_audit_log       — text-ops bot write audit trail (#168; 2026-07-22)
--   30. bot_users           — text-ops bot roster/roles, managed from
--       Settings → Bot team (#168; 2026-07-23)
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
-- from their own CREATE). So a fresh in-order rebuild THROUGH 2026-06-28 is
-- safe: no table live as of that date is left RLS-disabled at the end. (This
-- did not hold for the file as a WHOLE between the 2026-08-03 regen and
-- 2026-08-24: inventory_orders, created 2026-07-06, shipped RLS-disabled in
-- between; see its own posture bullet near the top of this file. Not a
-- W2-006-shaped footgun while it lasted (no later blanket-enable migration
-- existed to have "already covered" it) — a distinct gap, closed by
-- 2026-08-24-inventory-orders-enable-rls.sql / ledger row 329.) The FOOTGUN W2-006 actually flags is
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
  -- 2026-08-22 retry leases: guard customer re-delivery and GHL retries
  -- independently before either can invoke an external provider.
  add column if not exists delivery_retry_claimed_at timestamptz,
  add column if not exists ghl_retry_claimed_at timestamptz,
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
  add column if not exists legacy_rebook boolean not null default false,
  -- 2026-07-22 Valor Vault's own customer id (#161 "both vaults" decision),
  -- distinct from valor_vault_token (the raw payment token captured via the
  -- redirect_url path).
  add column if not exists valor_vault_customer_id text,
  -- 2026-07-28 View-only quotes (#176) — a quote staff created purely so a
  -- customer can browse a designed scene (colors, prices) WITHOUT being able
  -- to approve or pay a real deposit. Every approve/pay/decline/request-
  -- changes surface must gate on this as a POSITIVE match (view_only = true),
  -- never negative, so a normal quote is unaffected (AGENTS.md seam-gate
  -- rule). Applied out-of-band directly on prod; this file documents it.
  add column if not exists view_only boolean not null default false,
  -- 2026-07-29 Deposit/balance card-decline notification (#175) — the webhook
  -- route stamps these so a declined charge no longer vanishes into a
  -- console.warn; deposit_decline_notified_at is the once-per-hour staff-
  -- alert throttle claim. Applied out-of-band directly on prod; this file
  -- documents it.
  add column if not exists deposit_declined_at timestamptz,
  add column if not exists deposit_decline_code text,
  add column if not exists deposit_decline_notified_at timestamptz,
  -- 2026-08-05 NCE tag (#198) — row 188 true-up 2026-08-26: applied by
  -- migrations/2026-08-05-nce-customer-tags.sql, never folded into this file
  -- (predates the same-PR fold-in rule).
  add column if not exists is_nce boolean not null default false;

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

-- 2026-08-05 corpus source tag (archive-slice3) — row 188 true-up 2026-08-26:
-- this column + index were applied by
-- migrations/2026-08-05-archive-slice3-corpus-and-night-photos.sql but never
-- folded into this file (the migration predates the same-PR fold-in rule).
alter table training_houses
  add column if not exists source text not null default 'manual';

alter table training_houses enable row level security;
create index if not exists training_houses_created_at_idx on training_houses (created_at desc);
create index if not exists training_houses_address_idx on training_houses (address);
create index if not exists training_houses_source_created_idx
  on public.training_houses (source, created_at desc);


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
  add column if not exists photo_title text,
  -- 2026-08-21 independent customer-portal image visibility controls.
  add column if not exists portal_show_street_view boolean not null default true,
  add column if not exists portal_show_satellite_view boolean not null default true,
  -- 2026-08-20 compare-and-swap guard for the scene autosave (ledger row
  -- 260, migrations/2026-08-20-designs-scene-version.sql). Every scene write
  -- goes UPDATE ... WHERE version = <last-read value> SET version =
  -- version + 1 — zero rows updated means a concurrent writer won the race.
  add column if not exists version integer not null default 1;

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

-- Fix round (PR #916): which ANALYZER_PROMPT_VERSION (src/lib/photoAnalysis.ts)
-- produced original_analysis — see migrations/2026-08-28-training-examples-
-- prompt-version.sql for the full rationale. Null = pre-versioning row.
alter table training_examples
  add column if not exists prompt_version text;

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
--     #213: a candidate that doesn't clear the identity-agreement adoption
--     bar (src/lib/customers.ts classifyCandidate) creates a NEW row keyed
--     `dup:[["label","value"],...]` (JSON-encoded field pairs) instead of
--     one of the four shapes above — still UNIQUE, still race-safe.
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

-- 2026-07-10 Customer-facing referral identity (ledger #41 referral program).
-- referral_code: the short URL-safe code behind /refer/<code> (ensureReferralCode
-- create-if-missing, race-safe via the UNIQUE constraint). Null until a
-- customer's code is first ensured (the booked-page referral section, or the
-- GHL stamp).
-- referral_photo_optout: when true, the /refer/<code> landing page skips
-- using this customer's own house photo as the hero (falls back to a generic
-- completed-work gallery photo instead). Defaults false (opt-out, not
-- opt-in).
alter table public.customers
  add column if not exists referral_code text unique;
alter table public.customers
  add column if not exists referral_photo_optout boolean not null default false;

-- 2026-08-05 NCE + YLL Neighbor tags (#198) — row 188 true-up 2026-08-26:
-- applied by migrations/2026-08-05-nce-customer-tags.sql, never folded in.
alter table public.customers
  add column if not exists is_nce boolean not null default false,
  add column if not exists is_yll_neighbor boolean not null default false;

-- 2026-07-28 Customer tenure (#178) staff-editable manual override years,
-- unioned with the auto-derived set (deposit-paid + legacy-rebook years) in
-- src/lib/customerTenure.ts.
alter table public.customers
  add column if not exists manual_years jsonb not null default '[]';


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

-- 2026-08-07 Properties nickname + archive (#205) -- customer-profile
-- Properties tab full manage. nickname: staff-only display label, purely
-- cosmetic (never used for matching/dedup -- that stays on address_key).
-- archived_at: hides a property from the default list WITHOUT deleting it
-- (quotes/jobs/invoices reference properties by id) -- auto-clears the
-- moment new quote activity lands on it again (see findOrCreateProperty's
-- #205 comment in src/lib/customers.ts). Both nullable, no default beyond
-- NULL. See migrations/2026-08-07-properties-nickname-and-archive.sql.
alter table public.properties
  add column if not exists nickname text;
alter table public.properties
  add column if not exists archived_at timestamptz;

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

  -- P4P Phase 1 planning estimate (2026-08-07): budgeted install hours and the
  -- labor-revenue figure shadow-mode reporting builds from. Placeholder-rate
  -- marker stays true until Jason's real production-rate session lands.
  budgeted_hours numeric,
  labor_revenue_cents integer,
  rates_are_placeholder boolean not null default true,
  budgeted_hours_overridden_at timestamptz,
  budgeted_hours_overridden_by text,

  -- Install date — synced from home.works later (#84).
  install_date  date,

  -- When the job was marked done/installed-complete (#83 invoice trigger).
  completed_at  timestamptz,

  -- #82 Phase 2 (stock loop, 2026-06-27): records WHEN a job's materials
  -- were prepped and its on-hand stock decremented, so the decrement fires
  -- exactly once per job (idempotent "prepare"). NULL = not yet prepped.
  stock_decremented_at timestamptz,

  -- Row 325 (2026-08-24): the exact StockDeduction[] prepareJobMaterials
  -- deducted at prep time, so a cancel-reversal returns exactly what prep
  -- took off the shelf instead of recomputing the materials projection live
  -- (which silently drifts if the materials rules change in between). NULL
  -- when never prepped, or when prepped before this column existed (the
  -- cancel route falls back to a live reconstruction for those legacy jobs).
  stock_deductions jsonb,

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

-- 2026-07-22 Stock true-up idempotency claim (text-ops bot Phase 2, #168):
-- the same guard idiom as stock_decremented_at above. NULL = actuals never
-- recorded; set once the crew's reported usage has trued up on-hand stock, so
-- a retry/double-tap/two-crew-members submission can never true up twice.
alter table public.jobs
  add column if not exists materials_actualized_at timestamptz;

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

-- 2026-07-24 Auto-charge arming checklist (#170):
--   valor_txn_log — jsonb array of retired charge records. When an amend
--     reopens a PAID invoice (new balance due), the live
--     valor_balance_txn_id/valor_receipt_url move here so the new charge
--     cycle starts clean, while the old txn stays reconcilable.
--   payment_preference — how this customer pays the balance:
--     'card_on_file' | 'cash_check' | null (unset). 'cash_check' replaces the
--     one-click charge button with an explicit override so nobody charges a
--     card the customer said they'd settle in cash.
alter table public.invoices add column if not exists valor_txn_log jsonb;
alter table public.invoices add column if not exists payment_preference text;
alter table public.invoices drop constraint if exists invoices_payment_preference_check;
alter table public.invoices add constraint invoices_payment_preference_check
  check (payment_preference is null or payment_preference in ('card_on_file', 'cash_check'));

-- 2026-08-07 Manual payment method + NCE reference (#199):
--   paid_method — how a MANUALLY-settled invoice (mark-paid, not a Valor
--     charge) was actually collected: 'cash_check' | 'nce' | null. null covers
--     BOTH a legacy manual mark-paid (predates this column) and a
--     Valor-settled invoice (the balance webhook / charge-balance route settle
--     via valor_balance_txn_id, never write this column) — the two null cases
--     are told apart by whether valor_balance_txn_id is set.
--   payment_reference — the NCE trade-system payment reference number.
--     Required at NCE mark-paid time (enforced in the app, not a DB
--     constraint — an empty ref means the trade payment hasn't happened yet);
--     editable afterward for a typo fix.
-- These MUST be here: INVOICE_SELECT (src/lib/invoices.ts) is a literal column
-- list, so a DB built from this file without them fails EVERY invoice read and
-- every job-completion invoice creation (PostgREST 42703), not just NCE ones.
-- See migrations/2026-08-07-invoices-manual-payment-method.sql.
alter table public.invoices add column if not exists paid_method text;
alter table public.invoices add column if not exists payment_reference text;
alter table public.invoices drop constraint if exists invoices_paid_method_check;
alter table public.invoices add constraint invoices_paid_method_check
  check (paid_method is null or paid_method in ('cash_check', 'nce'));

-- 2026-08-11 settled_by (#225): the operator who manually settled the
-- invoice. Mirrors inbox_items.handled_by — nullable uuid FK to auth.users,
-- ON DELETE SET NULL. See migrations/2026-08-11-invoices-settled-by.sql.
alter table public.invoices
  add column if not exists settled_by uuid references auth.users(id) on delete set null;


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

-- 2026-07-06 CUSTOMER inbound-touch time (#110 W7-003), tracked separately
-- from last_message_at (which gets overwritten by our own outbound reply on
-- every reconcile). Response-time metrics read handled_at − last_inbound_at,
-- falling back to last_message_at for historical rows whose true inbound
-- time the old bug already overwrote. Nullable, no backfill, no index (read
-- in bulk, computed in JS).
alter table public.inbox_items add column if not exists last_inbound_at timestamptz;

-- 2026-07-07 Reply double-submit guard: POST /api/dashboard/reply atomically
-- claims this column BEFORE firing the real GHL SMS/email send, so a network
-- retry or a stale second operator tab can't double-send. Released back to
-- null on a genuine send failure. Nullable, no backfill, no index (read/
-- written only by id).
alter table public.inbox_items add column if not exists reply_claimed_at timestamptz;

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
  -- Row 390 (2026-08-25): non-null only when this pending nudge is a
  -- RE-CHASE (row 385's re-arm after 7 quiet days on a handled item) - the
  -- silence-start anchor (followups.ts's reChaseAnchor), so the "due today"
  -- strip can tell a re-chase apart from a first-time nudge and show how
  -- long the customer has been quiet. See migrations/2026-08-25-follow-ups-
  -- re-chase-since.sql for the full reasoning.
  re_chase_since timestamptz null,
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
-- 2026-08-03 (#189): partial index over the non-firehose actions only
-- ('ingested'/'escalated' excluded — 99.86% of the table's ~937k rows). Serves
-- getReopenCounts()'s `action = 'handled' | 'reopened'` scans (11.6s full seq
-- scan measured on prod pre-index → the dominant cost of the #185
-- [inbox-timing] page-load figure) and listActivity's NOT action IN
-- ('ingested','escalated') filter.
create index if not exists dashboard_activity_operator_actions_idx
  on public.dashboard_activity (action, created_at desc)
  where action not in ('ingested', 'escalated');

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
  refresh_token_enc text,                             -- AES-256-GCM via src/lib/crypto/secretBox.ts
  access_token_enc  text,                             -- same box; short-lived but still a live credential
  access_token_expires_at timestamptz,                -- NULL when the provider does not say
  scope             text,                             -- what the grant covers, as the provider described it
  watch_history_id  text,
  watch_expiration  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint integration_tokens_provider_account_key unique (provider, account_email)
);

-- Rotation happens on every refresh, so "when did this last change" is the first
-- question during an outage.
create or replace function integration_tokens_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists integration_tokens_updated_at_trigger on public.integration_tokens;
create trigger integration_tokens_updated_at_trigger
  before update on public.integration_tokens
  for each row execute function integration_tokens_set_updated_at();

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


-- =====================================================================
-- Tables 22-31 — everything that landed after the 2026-07-03 regen
-- (2026-08-03 regen, ledger #188). Back to the "classic" service-role-only
-- posture (RLS enabled, no policies) — INCLUDING inventory_orders as of
-- 2026-08-24-inventory-orders-enable-rls.sql (ledger row 329); see its own
-- note below. Not part of the #58 dashboard-tables banner above; sequenced
-- here purely by migration date.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 22. inventory_orders  (P8, #110 W7-002 — supplier auto purchase order)
--     On-order ledger. One row per SENT purchase order. Recording an order
--     BEFORE the future demand calc subtracts it (buildSupplierPurchaseOrder)
--     means a re-send lists only the NEW shortfall, not the full cumulative
--     one. `lines` = [{sku, name, qty}] as ordered; `received_lines` =
--     [{sku, qty}] set at receive time (may differ from `lines` on a short
--     shipment).
--
--     RLS ENABLED, no policies (row 329, 2026-08-24) — brought in line with
--     its inventory_catalog / inventory_on_hand siblings; every consumer
--     (src/lib/inventory/orders.ts) already used the service-role client
--     exclusively, so this closes the anon-key hole with no code path
--     affected. Previously shipped RLS-DISABLED since its 2026-07-06
--     creation — see the posture note at the top of this file for that
--     history. NOTE: as of the PR that added the 2026-08-24 migration, that
--     migration is UNAPPLIED to prod (an RLS change on an existing table is
--     ask-first per AGENTS.md, not auto-applied) — this file describes the
--     schema once it IS applied, per this file's own convention of
--     reflecting migrations/*.sql in date order.
-- ---------------------------------------------------------------------
create table if not exists inventory_orders (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  channel         text not null check (channel in ('manual', 'auto-cron', 'auto-webhook')),
  status          text not null default 'open' check (status in ('open', 'received', 'cancelled')),
  received_at     timestamptz,
  lines           jsonb not null,
  received_lines  jsonb,
  job_count       int not null default 0
);

alter table inventory_orders enable row level security;

create index if not exists inventory_orders_status_open_idx
  on inventory_orders (status)
  where status = 'open';


-- ---------------------------------------------------------------------
-- 23. permanent_training_examples  (#141 — the PERMANENT-lighting AI
--     training loop; mirrors #8 Stage A/B for holiday, but SEPARATE storage +
--     retrieval — the two verticals teach two different analyzers with
--     different ground-truth shapes.)
--     One row = one operator-confirmed "the AI traced X, staff confirmed Y"
--     snapshot: the FOUR satellite side channels (front/left/right/back) as
--     ground truth, plus confirmed street runs + the AI's original pass for
--     provenance. Soft links (quote_id/design_id) so deleting the quote/
--     design must NOT delete the example. SATELLITE-PRIMARY: the embedding
--     is the satellite image (the analyzer's primary input), so
--     satellite_photo_base64 is NOT NULL; street is optional. Reached only
--     via the service-role client; RLS enabled with no policies (#90).
-- ---------------------------------------------------------------------
create table if not exists permanent_training_examples (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  quote_id      uuid references quotes(id) on delete set null,
  design_id     uuid references designs(id) on delete set null,
  source        text not null default 'manual',     -- 'auto-send' | 'manual'
  excluded      boolean not null default false,     -- park an oddball out of the few-shot
  notes         text,
  address       text,
  street_photo_base64    text,
  street_media_type      text,
  satellite_photo_base64 text not null,
  satellite_media_type   text not null,
  satellite_feet_per_pixel numeric,
  original_analysis      jsonb,    -- raw PermanentSatelliteAnalysis; NULL = manual design, no AI run
  final_satellite_lines   jsonb not null,            -- PermanentSatelliteLines shape — the ground truth
  final_street_runs       jsonb,                     -- PermanentStreetRun[], when present
  final_inputs            jsonb,   -- per-side footage/corners/accessories context (not re-taught directly)
  embedding               vector(1024)
);

alter table permanent_training_examples drop constraint if exists permanent_training_examples_source_check;
alter table permanent_training_examples add constraint permanent_training_examples_source_check
  check (source in ('auto-send', 'manual'));

alter table permanent_training_examples enable row level security;

create index if not exists permanent_training_examples_created_at_idx
  on permanent_training_examples (created_at desc);

-- Upsert semantics: a quote keeps at most ONE example per source (mirrors
-- training_examples_quote_source_uniq exactly; NOT partial — PostgREST's ON
-- CONFLICT can't infer a partial unique index; NULL quote_ids are distinct
-- under Postgres unique semantics anyway).
create unique index if not exists permanent_training_examples_quote_source_uniq
  on permanent_training_examples (quote_id, source);

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

-- Cosine-similarity retrieval on the SATELLITE embedding — twin of
-- match_training_examples, same shape, own table.
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


-- ---------------------------------------------------------------------
-- 24. referrals  (ledger #41 — referral program)
--     Locked product (Naldo, S30): the referrer earns $125 next-season
--     credit per booked friend, stackable (one row per friend, no cap). The
--     friend gets two free 16" spritzers on their first booked install
--     (redemption UI, separate). Attribution is BOTH ways: 'link' (the
--     referrer's personal /refer/<code> link; referee_quote_id NULL at
--     creation — a lead capture before any quote exists) or 'mention' (staff
--     picks an existing customer as "Referred by" while building a new
--     quote; referee_quote_id known immediately). accrueOnBooking
--     (src/lib/referrals.ts) flips pending → booked when the referee_quote_id's
--     deposit is paid — matches ONLY on referee_quote_id, so a 'link' row
--     never auto-accrues on its own. UNIQUE(referee_quote_id) is the
--     once-per-referee idempotency backstop. Reached only via the
--     service-role client; RLS enabled with no policies (#90).
-- ---------------------------------------------------------------------
create table if not exists public.referrals (
  id                    uuid primary key default gen_random_uuid(),
  referrer_customer_id  uuid references public.customers(id) on delete set null,
  referee_quote_id      uuid references public.quotes(id) on delete set null,
  referee_contact_name  text,
  referee_contact_email text,
  referee_contact_phone text,
  source                text not null,
  status                text not null default 'pending',
  amount_usd            numeric not null default 125,
  booked_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table public.referrals drop constraint if exists referrals_source_check;
alter table public.referrals add constraint referrals_source_check
  check (source in ('link', 'mention'));

alter table public.referrals drop constraint if exists referrals_status_check;
alter table public.referrals add constraint referrals_status_check
  check (status in ('pending', 'booked', 'credited'));

-- The once-per-referee idempotency backstop (see header above).
alter table public.referrals drop constraint if exists referrals_referee_quote_id_key;
alter table public.referrals add constraint referrals_referee_quote_id_key unique (referee_quote_id);

create index if not exists referrals_referrer_customer_id_idx
  on public.referrals (referrer_customer_id);

alter table public.referrals enable row level security;

create or replace function public.referrals_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists referrals_updated_at_trigger on public.referrals;
create trigger referrals_updated_at_trigger
  before update on public.referrals
  for each row execute function public.referrals_set_updated_at();

-- 2026-07-11 Redemption columns (ledger #41 PR 2) — consumeCredits
-- (src/lib/referrals.ts) stamps these when a referrer's balance is SPENT as a
-- discount on a quote. credited_quote_id is the REFERRER's own later quote
-- the credit was applied to — NOT the friend's referee_quote_id that earned
-- it; the two can be different quotes, different customers even.
alter table public.referrals
  add column if not exists credited_at timestamptz;
alter table public.referrals
  add column if not exists credited_quote_id uuid references public.quotes(id) on delete set null;

create index if not exists referrals_credited_quote_id_idx
  on public.referrals (credited_quote_id);

-- 2026-07-11 Credit expiry (ledger #41 follow-up) — a referral credit expires
-- 2 years after it's EARNED (booked_at + 2 years, stamped by accrueOnBooking
-- in the same update that flips pending → booked). NULL = non-expiring
-- (grandfathered — existing 'booked' rows predating this column). A 'booked'
-- row whose expires_at has passed stays status='booked' forever; it's just
-- excluded from the spendable balance by creditBalanceFor's check.
alter table public.referrals
  add column if not exists expires_at timestamptz;


-- ---------------------------------------------------------------------
-- 25. website_leads  (lead-capture for the WordPress custom quote-request
--     forms; yulelovelights.com → POST /api/leads)
--     Replaces the old plugin that routed EVERY lead into the Christmas
--     pipeline regardless of the service the visitor actually asked about —
--     this table is the source of truth / retry queue, written FIRST on
--     every submission; the route then syncs each row to the correct
--     per-service HighLevel pipeline (src/lib/leads/leadService.ts).
--     sync_status: 'pending' (saved, sync not yet attempted or it failed —
--     retry queue) | 'synced' | 'spam' (honeypot/too-fast — kept for
--     visibility, GHL skipped) | 'deferred' (service resolved but its GHL
--     pipeline env vars aren't set yet) | 'rate_limited' (deliberate
--     throttle) | 'failed' (2026-07-12 — retry attempts exhausted, parked for
--     a manual re-drive). No DB CHECK constraint on sync_status/service —
--     validated in application code.
--     RLS ENABLED, ZERO POLICIES — service-role only (POST /api/leads runs
--     server-side only), matching the #90 all-tables hardening pattern.
-- ---------------------------------------------------------------------
create table if not exists public.website_leads (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  form_variant        text not null,               -- which embedded form (e.g. 'hero', 'sticky', 'footer')
  service             text not null,                -- christmas | permanent | event-wedding | landscape
  name                text not null,
  email               text not null,
  phone               text not null,
  address             text,
  notes               text,
  consent             boolean not null default false,
  utm                 jsonb,
  landing_url         text,
  ip                  text,
  ghl_contact_id      text,
  ghl_opportunity_id  text,
  sync_status         text not null default 'pending',
  sync_error          text,
  is_test             boolean not null default false
);

-- Newest-first admin views / cleanup.
create index if not exists website_leads_created_at_idx
  on public.website_leads (created_at);

-- The rate-limit query (count from this IP in the last hour).
create index if not exists website_leads_ip_created_at_idx
  on public.website_leads (ip, created_at);

alter table public.website_leads enable row level security;

-- 2026-07-12 Retry bookkeeping (src/lib/leads/leadRetry.ts) — bounds
-- automatic retries and surfaces stuck rows on /admin/leads. MIGRATION
-- ORDER: additive + nullable/defaulted, ships migration-first. Old rows get
-- retry_count = 0, last_retried_at = NULL — exactly what the worker treats as
-- "never retried, most urgent" (nulls-first ordering).
alter table public.website_leads
  add column if not exists retry_count integer not null default 0;
alter table public.website_leads
  add column if not exists last_retried_at timestamptz;

-- The retry worker's scan: still-stuck rows, oldest attempt first. Partial
-- (only pending/deferred rows are ever selected) keeps it tiny.
create index if not exists website_leads_retry_idx
  on public.website_leads (last_retried_at)
  where sync_status in ('pending', 'deferred');


-- ---------------------------------------------------------------------
-- 26. self_serve_estimates  (accuracy telemetry for the customer self-serve
--     estimator)
--     One row per self-serve quote at the moment /api/estimate priced it:
--     the RANGE the customer was shown (estimate_low..estimate_high) + the
--     analyzer's confidence + the raw engine total (estimate_total) the
--     range was built from. Written at creation, never updated — the
--     "verified final" price is read live from the linked quotes.total, so
--     the dashboard can compare "what we quoted instantly" vs "what staff
--     confirmed." quote_id FK ON DELETE CASCADE: deleting a quote drops its
--     estimate row too. RLS ENABLED, ZERO POLICIES — service-role only
--     (POST /api/estimate + the dashboard loader run server-side only).
-- ---------------------------------------------------------------------
create table if not exists public.self_serve_estimates (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  quote_id       uuid not null references public.quotes(id) on delete cascade,
  estimate_low   numeric(10,2) not null,
  estimate_high  numeric(10,2) not null,
  estimate_total numeric(10,2),
  confidence     text
);

create index if not exists self_serve_estimates_quote_id_idx
  on public.self_serve_estimates (quote_id);
create index if not exists self_serve_estimates_created_at_idx
  on public.self_serve_estimates (created_at);

alter table public.self_serve_estimates enable row level security;


-- ---------------------------------------------------------------------
-- 27. self_serve_analyzer_budget  (self-serve estimator's aggregate daily
--     SPEND guard)
--     /api/estimate spends money per accepted request (Claude analyzer +
--     Google Maps). Per-IP rate limiting caps one attacker's rate; this caps
--     the TOTAL across all IPs so a distributed bot can't run up the bill.
--     One row per UTC day holding the count of paid analyzer runs; the route
--     stops once the day's count passes SELF_SERVE_DAILY_ANALYZER_CAP (env;
--     default 300). RLS ENABLED, ZERO POLICIES — service-role only.
-- ---------------------------------------------------------------------
create table if not exists public.self_serve_analyzer_budget (
  day   date primary key default (now() at time zone 'utc')::date,
  count integer not null default 0
);

alter table public.self_serve_analyzer_budget enable row level security;

-- Atomic consume-one-unit: upsert today's row incrementing the count, and
-- return the NEW count — one statement, so concurrent lambdas across regions
-- can't race. Runs under the service-role (BYPASSRLS) the server uses, so no
-- SECURITY DEFINER is needed.
create or replace function public.bump_self_serve_analyzer_budget()
returns integer
language sql
as $$
  insert into public.self_serve_analyzer_budget (day, count)
  values ((now() at time zone 'utc')::date, 1)
  on conflict (day)
    do update set count = self_serve_analyzer_budget.count + 1
  returning count;
$$;


-- ---------------------------------------------------------------------
-- 28. job_material_actuals  (#168 text-ops bot Phase 2 — what a job REALLY
--     used, captured from the field)
--     prepareJobMaterials deducts the ESTIMATED BOM at prep time; this table
--     closes the loop with what the crew actually consumed. One row per
--     (job, sku) submission — the bot writes these when a crew member texts
--     "job 142 done — 2 boxes C9, 30 clips"; the stock true-up then adjusts
--     on-hand by the DIFFERENCE between estimate and actual
--     (materialActuals.ts). jobs.materials_actualized_at (added in the jobs
--     section above) is the idempotency claim — a retry/double-tap/two-crew
--     submission finds the stamp already set and applies nothing. RLS
--     ENABLED, ZERO POLICIES — service-role only (the bot runs server-side).
-- ---------------------------------------------------------------------
create table if not exists public.job_material_actuals (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  sku         text not null,
  qty         integer not null default 0 check (qty >= 0),
  -- The estimate this submission was compared against when the true-up ran
  -- (prepareJobMaterials doesn't persist what it deducted, so the baseline is
  -- otherwise unreconstructable once the design has changed again).
  estimated_qty integer not null default 0 check (estimated_qty >= 0),
  raw_text    text,        -- what the crew typed, verbatim, for dispute/debug
  recorded_by text,        -- Telegram chat id (or 'staff:<label>') — the audit trail
  created_at  timestamptz not null default now()
);

create index if not exists job_material_actuals_job_id_idx
  on public.job_material_actuals (job_id);

alter table public.job_material_actuals enable row level security;


-- ---------------------------------------------------------------------
-- 29. bot_pending_actions  (#168 text-ops bot — the confirm-yes gate's memory)
--     Every sensitive bot write echoes a one-line summary and waits for
--     "yes" before it runs, so a misread text is harmless until confirmed.
--     Lambdas are stateless, so the pending action lives here between the
--     two messages. Rows are consumed ATOMICALLY (set consumed_at WHERE
--     consumed_at is null) so a double "yes" can only execute once. RLS
--     ENABLED, ZERO POLICIES — service-role only.
-- ---------------------------------------------------------------------
create table if not exists public.bot_pending_actions (
  id          uuid primary key default gen_random_uuid(),
  chat_id     text not null,
  -- The SENDER, not the room: in a group chat each person confirms their own
  -- pending action, and roles are keyed to the user too.
  user_id     text not null,
  tool        text not null,
  args        jsonb not null default '{}'::jsonb,
  summary     text not null,      -- the exact confirm line shown, replayed in the audit entry
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);

create index if not exists bot_pending_actions_open_idx
  on public.bot_pending_actions (chat_id, user_id, created_at desc)
  where consumed_at is null;

alter table public.bot_pending_actions enable row level security;


-- ---------------------------------------------------------------------
-- 30. bot_audit_log  (#168 text-ops bot — who asked the bot to do what, and
--     what happened)
--     Every write the bot performs lands here, including denied attempts, so
--     an unexpected stock or CRM change is always traceable back to a person
--     and a message. RLS ENABLED, ZERO POLICIES — service-role only.
-- ---------------------------------------------------------------------
create table if not exists public.bot_audit_log (
  id         uuid primary key default gen_random_uuid(),
  chat_id    text,
  user_id    text,
  role       text,
  tool       text not null,
  args       jsonb not null default '{}'::jsonb,
  outcome    text not null,
  detail     text,
  created_at timestamptz not null default now()
);

create index if not exists bot_audit_log_created_at_idx
  on public.bot_audit_log (created_at desc);

alter table public.bot_audit_log enable row level security;


-- ---------------------------------------------------------------------
-- 31. bot_users  (#168 text-ops bot roster, managed from Settings → Bot team)
--     Moves crew/staff/admin role management OFF the TELEGRAM_ADMIN/STAFF/
--     CREW_USERS env vars (which needed a Vercel redeploy on every roster
--     change) into a DB table an admin edits in the app. One row per
--     Telegram USER id (message.from.id), NOT per chat — roles are keyed to
--     the person, so the same user carries their role into any allowlisted
--     room (the room allowlist itself stays in TELEGRAM_ALLOWED_CHATS). The
--     env vars remain a LOCKOUT-PROOF FLOOR: resolveSenderRole takes the
--     higher of the DB role and the env role, so bootstrap admins can never
--     be demoted out of access by a bad DB edit. RLS ENABLED, ZERO POLICIES
--     — service-role only (admin API routes run server-side behind
--     requireAdmin).
-- ---------------------------------------------------------------------
create table if not exists public.bot_users (
  telegram_user_id text primary key,
  display_name     text,
  role             text not null check (role in ('crew', 'staff', 'admin')),
  added_by         text,       -- who added/last-changed this row (an operator email or 'seed')
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.bot_users enable row level security;

create or replace function public.bot_users_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists bot_users_updated_at on public.bot_users;
create trigger bot_users_updated_at
  before update on public.bot_users
  for each row execute function public.bot_users_set_updated_at();

-- ---------------------------------------------------------------------
-- crew_members (2026-08-07, migrations/2026-08-07-crew-members.sql +
-- migrations/2026-08-07-crew-members-name-unique.sql) — the P4P / Operations
-- Hub identity + pay-config cache. `hub_employee_id` stays nullable until the
-- Hub's OTP auth ships and backfills it. `telegram_user_id` links to
-- bot_users when known. RLS ENABLED, ZERO POLICIES — service-role only.
-- Folded into this canonical file at the S57 wrap review (was missing here
-- even though both migrations were already applied to prod — a fresh
-- onboarding DB built from this file alone would have had no crew_members
-- table at all).
-- ---------------------------------------------------------------------
create table if not exists public.crew_members (
  id               uuid primary key default gen_random_uuid(),
  hub_employee_id  uuid,
  telegram_user_id text,
  display_name     text not null,
  base_rate_cents  integer not null,
  in_p4p_pool      boolean not null default false,
  pay_mode         text not null default 'hourly' check (pay_mode in ('hourly', 'shadow', 'p4p')),
  language         text not null default 'en',
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists crew_members_hub_employee_id_key
  on public.crew_members (hub_employee_id) where hub_employee_id is not null;

create unique index if not exists crew_members_telegram_user_id_key
  on public.crew_members (telegram_user_id) where telegram_user_id is not null;

-- Shared-auth-store link (2026-08-16, row 279): the SAME login serves the Quote
-- Tool and the Operations Hub. Crew logins carry app_metadata.role='crew' and are
-- rejected by getOperator/requireOperator/requireAdmin and by the role-aware
-- proxy — shared identity is NOT shared authorization.
alter table public.crew_members
  add column if not exists auth_user_id uuid;

create unique index if not exists crew_members_auth_user_id_key
  on public.crew_members (auth_user_id) where auth_user_id is not null;

create unique index if not exists crew_members_display_name_key
  on public.crew_members (lower(trim(display_name)));

-- Office/field flag (Naldo 2026-08-22, migrations/2026-08-22-crew-members-is-office.sql):
-- true = OFFICE staff (operator login), false = FIELD crew (crew login / Telegram
-- clock). QT-internal presentation flag only — it excludes office staff from the
-- Settings crew-logins panel and from the field-crew assignment dropdowns, and is
-- NOT part of the Operations Hub contract. Office staff are recognised for time
-- capture by their operator session, not by this flag.
alter table public.crew_members
  add column if not exists is_office boolean not null default false;

alter table public.crew_members enable row level security;

create or replace function public.crew_members_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists crew_members_updated_at on public.crew_members;
create trigger crew_members_updated_at
  before update on public.crew_members
  for each row execute function public.crew_members_set_updated_at();

-- ---------------------------------------------------------------------
-- shifts (2026-08-07, migrations/2026-08-07-shifts.sql) — the canonical
-- day-level clock ledger for Operations Hub Flow B. `source` records how the
-- shift was opened; `close_source` how it was closed (nullable — null while
-- open); they can differ (opened via the Telegram bot, closed by an office
-- correction, say). The partial unique index is the real idempotency
-- guarantee — at most one open shift per person, enforced by the DB, not an
-- application check. RLS ENABLED, ZERO POLICIES — service-role only, fails
-- closed until the Flow B routes and policies ship. Folded into this
-- canonical file at the S57 wrap review (see the crew_members note above —
-- same gap, same fix).
-- ---------------------------------------------------------------------
create table if not exists public.shifts (
  id              uuid primary key default gen_random_uuid(),
  crew_member_id  uuid not null references public.crew_members(id),
  clock_in_at     timestamptz not null default now(),
  clock_out_at    timestamptz,
  source          text not null check (source in ('pwa', 'telegram', 'office', 'system')),
  close_source    text check (close_source in ('pwa', 'telegram', 'office', 'system')),
  device_time     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists shifts_one_open_per_person
  on public.shifts (crew_member_id) where clock_out_at is null;

create index if not exists shifts_crew_member_id_idx
  on public.shifts (crew_member_id);

alter table public.shifts enable row level security;

create or replace function public.shifts_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists shifts_updated_at on public.shifts;
create trigger shifts_updated_at
  before update on public.shifts
  for each row execute function public.shifts_set_updated_at();

-- ---------------------------------------------------------------------
-- shift_breaks (2026-08-11, migrations/2026-08-11-shift-breaks.sql) — unpaid
-- break tracking on the shifts ledger. Breaks are UNPAID, so paid time for a
-- shift is the clock envelope MINUS break time (the arithmetic lives in
-- src/lib/shiftBreaks.ts, with its own tests, because it feeds P4P payout
-- math). The partial unique index is the idempotency guarantee — at most one
-- open break per shift, enforced by the DB. `auto_closed` marks a break that a
-- clock-out ended rather than the crew member, which is what feeds the
-- `open_break` time exception queue; it is a review state, not an error.
-- `crew_member_id` is denormalized from the parent shift so the write path can
-- authorize without a join. RLS ENABLED, ZERO POLICIES — service-role only,
-- fails closed until the Flow B routes and policies ship.
-- ---------------------------------------------------------------------
create table if not exists public.shift_breaks (
  id              uuid primary key default gen_random_uuid(),
  shift_id        uuid not null references public.shifts(id),
  crew_member_id  uuid not null references public.crew_members(id),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  source          text not null check (source in ('pwa', 'telegram', 'office', 'system')),
  end_source      text check (end_source in ('pwa', 'telegram', 'office', 'system')),
  auto_closed     boolean not null default false,
  device_time     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint shift_breaks_ends_after_start check (ended_at is null or ended_at >= started_at)
);

create unique index if not exists shift_breaks_one_open_per_shift
  on public.shift_breaks (shift_id) where ended_at is null;

create index if not exists shift_breaks_shift_id_idx
  on public.shift_breaks (shift_id);

create index if not exists shift_breaks_crew_member_id_idx
  on public.shift_breaks (crew_member_id);

alter table public.shift_breaks enable row level security;

create or replace function public.shift_breaks_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists shift_breaks_updated_at on public.shift_breaks;
create trigger shift_breaks_updated_at
  before update on public.shift_breaks
  for each row execute function public.shift_breaks_set_updated_at();

-- ---------------------------------------------------------------------
-- quote_deliveries (2026-08-12, migrations/2026-08-12-quote-deliveries.sql) —
-- durable record of every attempt to deliver a quote (SMS/email via GHL) to a
-- CUSTOMER (#250). One row per attempt (send + each ?retryDelivery=1
-- redelivery), not one row per quote — see the migration file's own header
-- for the table-vs-columns rationale and the exact call-site scope (only the
-- POST /api/quotes/[id]/send customer messages; every other sendSms/sendEmail
-- caller sends a different customer message and is out of scope). RLS
-- ENABLED, ZERO POLICIES — service-role only, matches quote_view_events /
-- self_serve_estimates.
-- ---------------------------------------------------------------------
create table if not exists public.quote_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  quote_id            uuid not null references public.quotes(id) on delete cascade,
  channel             text not null check (channel in ('sms', 'email')),
  outcome             text not null check (outcome in ('sent', 'failed')),
  provider_message_id text,
  error               text
);

create index if not exists quote_deliveries_quote_id_idx
  on public.quote_deliveries (quote_id, created_at desc);

create index if not exists quote_deliveries_created_at_idx
  on public.quote_deliveries (created_at desc);

alter table public.quote_deliveries enable row level security;

-- ---------------------------------------------------------------------
-- job_segments (2026-08-12, migrations/2026-08-12-job-segments.sql) - per-job
-- time on the shift clock (Flow B, Track A Phase 2 slice 2). Arrive opens a
-- segment, depart closes it, at most one open per shift (partial unique index).
-- MONEY: job seconds / budgeted_hours is the efficiency the P4P pool pays on.
-- BREAKS PAUSE JOB TIME, so job seconds are segment spans MINUS overlapping
-- break spans (src/lib/jobSegments.ts on src/lib/timeSpans.ts). stoppage_reason
-- ships day one and cannot be backfilled. auto_closed marks a clock-out close,
-- feeding the open_segment exception queue - a review state, not an error.
-- RLS ENABLED, ZERO POLICIES - service-role only, fails closed until routes ship.
-- ---------------------------------------------------------------------
create table if not exists public.job_segments (
  id              uuid primary key default gen_random_uuid(),
  shift_id        uuid not null references public.shifts(id),
  crew_member_id  uuid not null references public.crew_members(id),
  job_id          uuid not null references public.jobs(id),

  arrived_at      timestamptz not null default now(),
  departed_at     timestamptz,

  entry_kind      text not null default 'install'
                    check (entry_kind in ('install', 'rework', 'non_billable')),

  -- Null while the segment is open; required by the application on close.
  stoppage_reason text
                    check (stoppage_reason in ('completed', 'weather', 'no_access', 'materials', 'other')),

  source          text not null check (source in ('pwa', 'telegram', 'office', 'system')),
  end_source      text check (end_source in ('pwa', 'telegram', 'office', 'system')),

  auto_closed     boolean not null default false,

  -- Only meaningful for entry_kind = 'non_billable'.
  approved_by     uuid references public.crew_members(id),
  approved_at     timestamptz,

  device_time     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- A segment cannot end before it began. Guards an office-correction typo
  -- from minting negative job time, which would understate efficiency.
  constraint job_segments_ends_after_start
    check (departed_at is null or departed_at >= arrived_at),

  -- A closed segment must say WHY it closed; an open one must not pretend to.
  constraint job_segments_reason_matches_state
    check ((departed_at is null) = (stoppage_reason is null)),

  -- Approval only belongs on a non_billable segment, and both halves travel
  -- together so "approved by nobody at some time" cannot be recorded.
  constraint job_segments_approval_shape
    check (
      (approved_by is null and approved_at is null)
      or (entry_kind = 'non_billable' and approved_by is not null and approved_at is not null)
    )
);

create unique index if not exists job_segments_one_open_per_shift
  on public.job_segments (shift_id) where departed_at is null;

create index if not exists job_segments_shift_id_idx
  on public.job_segments (shift_id);

create index if not exists job_segments_job_id_idx
  on public.job_segments (job_id);

create index if not exists job_segments_crew_member_id_idx
  on public.job_segments (crew_member_id);

-- The missed-tap backstop scans for open segments; keep that scan cheap.
create index if not exists job_segments_open_arrived_at_idx
  on public.job_segments (arrived_at) where departed_at is null;

alter table public.job_segments enable row level security;

create or replace function public.job_segments_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists job_segments_updated_at on public.job_segments;
create trigger job_segments_updated_at
  before update on public.job_segments
  for each row execute function public.job_segments_set_updated_at();


-- ---------------------------------------------------------------------
-- archive_photos (2026-07-23 + 2026-08-04 imagery + 2026-08-05 slice 3) —
-- the #167 training-corpus archive: historical job photos awaiting address
-- identification, promotion into training_houses, or exclusion. FOLDED INTO
-- THIS FILE 2026-08-16 (row 282) — it had been missing entirely since
-- 2026-07-23, so a fresh project built from this file alone had no
-- archive_photos table at all. Reconciled base create + both later
-- add-column passes, in date order.
-- ---------------------------------------------------------------------
create table if not exists public.archive_photos (
  id                          uuid primary key default gen_random_uuid(),
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),

  -- Provenance (from the Drive archive + the naming manifest).
  drive_file_id               text not null unique,
  source_folder               text,
  original_title              text,
  content_hash                text,               -- reserved for future pixel-dedup; drive_file_id is today's idempotency key

  classification              text not null default 'install_night',

  -- Human-resolved ground truth (from the photo-naming pass).
  resolved_address            text,
  -- Normalized twin of resolved_address, mirroring public.properties.address_key
  -- and src/lib/customers.ts normalizeAddress() (lowercase, [.,#] -> space,
  -- collapse whitespace). The review queue groups a property's many photos by
  -- THIS column, never the raw text: without it "6 BIRCH ROAD ..." and
  -- "6 birch road ..." split one 4-photo house into two queue cards, and a
  -- double-traced house gets double weight in few-shot retrieval.
  resolved_address_key        text generated always as (
                                nullif(btrim(regexp_replace(
                                  regexp_replace(lower(resolved_address), '[.,#]', ' ', 'g'),
                                  '\s+', ' ', 'g')), '')
                              ) stored,
  resolved_customer_id        uuid references public.customers(id) on delete set null,
  -- The 8-char customers.id prefix the naming pass recorded. Kept alongside the
  -- resolved uuid so a link that fails to resolve at load time is DETECTABLE
  -- (resolved_customer_ref not null and resolved_customer_id is null) and
  -- re-linkable later, instead of silently landing as an unflagged null.
  resolved_customer_ref       text,
  -- The name the human actually typed for this photo ("deborah sande",
  -- "Two Marriott Plaza"). It is the only independent cross-check that a
  -- customer link points at the RIGHT customer, so it lives on the row rather
  -- than only in the CSV manifest.
  resolved_name               text,
  resolved_ghl_id             text,
  not_in_crm                  boolean not null default false,

  -- Fetched daytime imagery (slice 2; null until then).
  satellite_ref               text,
  street_view_ref             text,
  satellite_feet_per_pixel    numeric,

  extracted_counts            jsonb,               -- OCR'd tree/bush markup counts — P2, null in P1

  status                      text not null default 'pending',
  reviewer_notes              text,
  promoted_training_house_id  uuid references public.training_houses(id) on delete set null
);

-- Grouping (group-by-property review) + queue reads + customer join. The
-- grouping index is on the NORMALIZED key, since that is what the queue
-- groups by; the raw address is only ever displayed, never grouped on.
create index if not exists archive_photos_status_idx
  on public.archive_photos (status);
create index if not exists archive_photos_resolved_address_key_idx
  on public.archive_photos (resolved_address_key);
create index if not exists archive_photos_customer_id_idx
  on public.archive_photos (resolved_customer_id);

-- Keep updated_at fresh on every write. Slices 2 and 3 UPDATE these rows
-- repeatedly (imagery attach, status transitions, reviewer notes), so without
-- this trigger updated_at would freeze at load time and any "stalled in the
-- queue" check would silently read the original insert timestamp. Matches the
-- every-table convention (customers, properties, permanent_training_examples...).
create or replace function public.archive_photos_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists archive_photos_updated_at_trigger on public.archive_photos;
create trigger archive_photos_updated_at_trigger
  before update on public.archive_photos
  for each row execute function public.archive_photos_set_updated_at();

-- Defense in depth (mirrors self_serve_estimates + website_leads): the
-- service-role key is the only path that ever reaches this table, so RLS with
-- ZERO policies denies anon/authenticated entirely while every server path
-- keeps working unchanged.
alter table public.archive_photos enable row level security;

alter table public.archive_photos
  add column if not exists satellite_w        integer,
  add column if not exists satellite_h        integer,
  add column if not exists imagery_error      text,
  add column if not exists imagery_fetched_at timestamptz;

-- The imagery worker claims work with
--   where status='pending' and satellite_ref is null and resolved_address is not null
-- and then groups by resolved_address_key. Index shaped to match: the partial
-- predicate is the cheap always-true-for-work part (satellite_ref is null), and
-- the leading columns are what the claim filters and groups on. The table is
-- 211 rows today, so this is about keeping the claim cheap as later manifest
-- drops land, not about today's performance.
create index if not exists archive_photos_imagery_pending_idx
  on public.archive_photos (status, resolved_address_key)
  where satellite_ref is null;

-- Private bucket for the fetched daytime imagery. Mirrors the 'designs'
-- bucket: private, service-role only, read back through a signed URL. The
-- epic spec's storage decision was bucket-first (path-referenced), never
-- base64 columns — googleMaps.ts hands back base64, so the worker uploads the
-- bytes here and stores only the path.
insert into storage.buckets (id, name, public)
values ('training-archive', 'training-archive', false)
on conflict (id) do nothing;

alter table public.archive_photos
  add column if not exists night_photo_ref text;

-- ---------------------------------------------------------------------
-- site_submissions (2026-08-04) — the #195 non-lead website forms
-- (newsletter / careers / intern / nomination). FOLDED INTO THIS FILE
-- 2026-08-16 (row 282); same gap as archive_photos above.
-- ---------------------------------------------------------------------
create table if not exists public.site_submissions (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),

  -- newsletter | careers | intern | nomination
  form_type      text not null,
  -- which placement it came from, e.g. 'footer', 'newsletter-page',
  -- 'careers-page', 'intern-page', 'hope-page'
  form_variant   text not null,

  -- Submitter. Only email is guaranteed: the footer newsletter form is a
  -- single email field, exactly as it was in Gravity Forms.
  name           text,
  email          text not null,
  phone          text,

  -- Everything form-specific: the application questions, and for a nomination
  -- the whole nominee block (their name, address, contact details, the story).
  -- Kept as jsonb so a new question does not need a schema change.
  payload        jsonb not null default '{}'::jsonb,

  -- Object path in the PRIVATE 'applications' storage bucket (created at the
  -- bottom of this file). Never a public URL: a resume is personal data and is
  -- served only through a short-lived signed URL minted for a signed-in staff
  -- user.
  resume_path    text,
  -- Set when an applicant DID attach a resume but the upload failed. Without
  -- this, a failed upload is indistinguishable from "applied without a resume"
  -- and staff would never know to ask for it.
  resume_error   text,

  consent        boolean not null default false,
  landing_url    text,
  utm            jsonb,
  ip             text,

  -- GHL contact for the SUBMITTER only, tagged by form type. A nominated third
  -- party is never created as a contact: they did not consent to anything.
  ghl_contact_id text,
  -- pending | synced | skipped | spam | error
  sync_status    text not null default 'pending',
  sync_error     text,

  is_test        boolean not null default false
);

-- Newest-first admin view.
create index if not exists site_submissions_created_at_idx
  on public.site_submissions (created_at desc);

-- The rate-limit query (count from this IP in the last hour), mirroring the
-- website_leads approach: a DB count survives serverless cold starts and
-- multiple regions in a way an in-memory counter does not.
create index if not exists site_submissions_ip_created_at_idx
  on public.site_submissions (ip, created_at);

-- Admin filtering by form type.
create index if not exists site_submissions_form_type_created_at_idx
  on public.site_submissions (form_type, created_at desc);

-- Service-role only, same as website_leads: RLS on with no policies, so the
-- anon key can neither read nor write. Every access goes through the server.
-- 2026-08-17 follow-ups (#195) — row 188 true-up 2026-08-26: applied to prod
-- as Supabase migration 20260817123021 (site_submissions_followups) but the
-- file was never committed; recovered as
-- migrations/2026-08-17-site-submissions-followups.sql. Statements verbatim.
alter table public.site_submissions
  add column if not exists handled_at timestamptz;
alter table public.site_submissions
  add column if not exists handled_by text;
create index if not exists site_submissions_unhandled_idx
  on public.site_submissions (created_at desc)
  where handled_at is null;
alter table public.site_submissions
  add column if not exists retry_count integer not null default 0;
alter table public.site_submissions
  add column if not exists last_retried_at timestamptz;
create index if not exists site_submissions_retry_idx
  on public.site_submissions (last_retried_at nulls first, created_at)
  where sync_status in ('pending', 'error');
alter table public.site_submissions
  add column if not exists nominee_consent boolean not null default false;
alter table public.site_submissions
  add column if not exists nominee_ghl_contact_id text;
alter table public.site_submissions
  add column if not exists nominee_sync_error text;

alter table public.site_submissions enable row level security;

-- The PRIVATE bucket resumes live in. Created here, in the same migration that
-- introduces the feature, matching every other storage-backed feature in this
-- repo (training-archive, custom-uploads, designs). Without this the upload
-- call fails with "bucket not found", which the route only logs — the
-- application would still be saved but the resume would silently never exist.
-- public = false is asserted by the migration rather than left to someone
-- remembering to tick a box in the Supabase dashboard.
insert into storage.buckets (id, name, public)
values ('applications', 'applications', false)
on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- job_assignments (2026-08-18, migrations/2026-08-18-job-assignments.sql) —
-- P4P Phase 3 scheduling: one row per (job, crew member, calendar day). A DATE
-- rather than a timestamptz, because "who is on this job on the 22nd" is a
-- calendar question and an instant would reintroduce UTC-vs-ET drift. Feeds
-- per-day capacity: job BH divided across the crew assigned to that job that
-- day, with a job scheduled and nobody assigned reported as UNASSIGNED load
-- rather than zero. ⚠️ BH is still placeholder, so capacity is too, and
-- src/lib/scheduling.ts tags it via readLaborPlan. RLS ENABLED, ZERO POLICIES.
-- ---------------------------------------------------------------------
create table if not exists public.job_assignments (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.jobs(id) on delete cascade,
  crew_member_id  uuid not null references public.crew_members(id),

  -- The calendar day this assignment is for, in the BUSINESS timezone. A DATE,
  -- not a timestamptz: "who is on this job on the 22nd" is a calendar question,
  -- and storing an instant would reintroduce the UTC-vs-ET drift this repo has
  -- already been bitten by.
  assigned_date   date not null,

  -- Who scheduled it, for the same reason every other consequential action here
  -- records a source.
  created_by      uuid references public.crew_members(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- One person cannot be assigned to the same job twice on the same day.
  constraint job_assignments_unique_per_day unique (job_id, crew_member_id, assigned_date)
);

-- ON DELETE CASCADE on job_id: an assignment to a deleted job is meaningless.
-- crew_member_id deliberately has NO cascade — deleting a crew member who has
-- scheduled work should fail loudly rather than silently unschedule the work.

create index if not exists job_assignments_date_idx
  on public.job_assignments (assigned_date);

create index if not exists job_assignments_crew_date_idx
  on public.job_assignments (crew_member_id, assigned_date);

create index if not exists job_assignments_job_id_idx
  on public.job_assignments (job_id);

alter table public.job_assignments enable row level security;

create or replace function public.job_assignments_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists job_assignments_updated_at on public.job_assignments;
create trigger job_assignments_updated_at
  before update on public.job_assignments
  for each row execute function public.job_assignments_set_updated_at();


-- ---------------------------------------------------------------------
-- quotes.browsing_selection / browsing_selection_updated_at (2026-08-19,
-- migrations/2026-08-19-quotes-browsing-selection.sql) — ledger row 239: the
-- customer's LIVE, still-editable portal selection (packageId/
-- selectedItemIds/rushSelected/takedownSelected/installTiming/colorSchemeId/
-- customPattern/permanentEffect), so the portal remembers what a customer
-- picked across visits (device change) and staff can see what a not-yet-
-- approved customer is leaning toward. Distinct from approval_snapshot (the
-- FROZEN agreement) — this column is written only pre-approval by
-- /api/quotes/[id]/selection and never trusted for money math; a saved
-- selection is reconciled against the quote's CURRENT packages/lineItems on
-- read (src/lib/portal/adapter.ts's resolveBrowsingSelectionSeed) before it
-- seeds anything, the same way approval selections already are. Both
-- nullable — no backfill needed.
-- ---------------------------------------------------------------------
alter table public.quotes
  add column if not exists browsing_selection jsonb;

alter table public.quotes
  add column if not exists browsing_selection_updated_at timestamptz;

comment on column public.quotes.browsing_selection is
  'Customer''s LIVE, still-editable portal selection (ledger row 239) — packageId/selectedItemIds/rushSelected/takedownSelected/installTiming/colorSchemeId/customPattern/permanentEffect. NOT the frozen agreement (see approval_snapshot); never trusted for money math; reconciled against live packages/lineItems on read (resolveBrowsingSelectionSeed). Written only pre-approval by /api/quotes/[id]/selection.';


-- ---------------------------------------------------------------------
-- staff_notes (2026-08-21, migrations/2026-08-21-staff-notes.sql) —
-- append-only internal notes shared by a quote and its linked job/invoice
-- admin pages. Service-role only; no browser policies.
-- ---------------------------------------------------------------------
create table if not exists public.staff_notes (
  id                  uuid primary key default gen_random_uuid(),
  quote_id            uuid not null references public.quotes(id) on delete cascade,
  body                text not null,
  created_by          uuid references auth.users(id) on delete set null,
  created_by_label    text not null,
  created_at          timestamptz not null default now(),
  client_request_id   uuid not null,
  -- Row 372 (2026-08-25, migrations/2026-08-25-staff-notes-redaction.sql):
  -- a withdrawn note keeps its row and its attribution; only the body is
  -- replaced by a tombstone. Non-null redacted_at means body is that
  -- tombstone, not what was originally written.
  redacted_at         timestamptz,
  redacted_by         uuid references auth.users(id) on delete set null,
  redacted_by_label   text,
  redacted_reason     text,

  constraint staff_notes_body_valid
    check (body = btrim(body) and char_length(body) between 1 and 2000),
  constraint staff_notes_created_by_label_valid
    check (
      created_by_label = btrim(created_by_label)
      and char_length(created_by_label) between 1 and 320
    ),
  constraint staff_notes_quote_request_unique
    unique (quote_id, client_request_id),
  -- Row 372: same shape guarantee the other text columns carry.
  constraint staff_notes_redacted_by_label_valid
    check (
      redacted_by_label is null
      or (redacted_by_label = btrim(redacted_by_label) and char_length(redacted_by_label) between 1 and 320)
    ),
  constraint staff_notes_redacted_reason_valid
    check (
      redacted_reason is null
      or (redacted_reason = btrim(redacted_reason) and char_length(redacted_reason) between 1 and 500)
    )
);

create index if not exists staff_notes_quote_created_idx
  on public.staff_notes (quote_id, created_at desc, id desc);

create index if not exists staff_notes_created_by_idx
  on public.staff_notes (created_by)
  where created_by is not null;

alter table public.staff_notes enable row level security;

revoke all on public.staff_notes from anon, authenticated, service_role;
grant select, insert on public.staff_notes to service_role;
-- Row 372: column-scoped on purpose — a redaction may rewrite the body and
-- stamp itself, and may NOT re-attribute, re-date, or reuse the idempotency
-- key of a note. Enforced by Postgres, not by the application.
grant update (body, redacted_at, redacted_by, redacted_by_label, redacted_reason)
  on public.staff_notes to service_role;

comment on table public.staff_notes is
  'Internal staff-only quote timeline, also shown on the linked job and invoice. Never customer-facing.';

-- ---------------------------------------------------------------------
-- quote_build_sessions (2026-08-21, migrations/2026-08-21-quote-build-sessions.sql)
-- - server-timed staff quote-building sessions, from accepted/prefilled
-- contact through the quote's first real sent transition. Private service-role
-- analytics only; test quotes, retries, and resends do not complete rows.
-- ---------------------------------------------------------------------
create table if not exists public.quote_build_sessions (
  id                uuid primary key,
  started_at        timestamptz not null default now(),
  start_reason      text not null
                      check (start_reason in ('contact_selected', 'prefilled_open')),
  started_by        uuid references auth.users(id) on delete set null,
  started_by_label  text not null
                      check (char_length(btrim(started_by_label)) between 1 and 200),
  quote_id          uuid references public.quotes(id) on delete cascade,
  sent_at           timestamptz,

  constraint quote_build_sessions_valid_completion
    check (sent_at is null or (quote_id is not null and sent_at >= started_at))
);

create unique index if not exists quote_build_sessions_quote_id_uidx
  on public.quote_build_sessions (quote_id)
  where quote_id is not null;

create index if not exists quote_build_sessions_started_by_idx
  on public.quote_build_sessions (started_by);

create index if not exists quote_build_sessions_sent_at_idx
  on public.quote_build_sessions (sent_at desc, id)
  where sent_at is not null;

alter table public.quote_build_sessions enable row level security;

revoke all on table public.quote_build_sessions from public, anon, authenticated, service_role;
grant select, insert, update on table public.quote_build_sessions to service_role;

-- quotes.ghl_event_date_pushed (2026-08-22,
-- migrations/2026-08-22-quotes-ghl-event-date-pushed.sql) — ledger #314 fix
-- round (staff-lens HIGH): the MM/DD/YYYY value last CONFIRMED pushed to
-- GHL's "Event Date" custom field, so every push site (send route,
-- quote/route.ts's date-changing update, the approve route reconcile)
-- compares "did OUR side change since we last pushed" instead of "does GHL
-- currently agree with us" — the latter silently reverts a staff correction
-- made directly in GHL. Nullable, no backfill; null = legacy/never-
-- confirmed-pushed row, handled conservatively (only overwrite an EMPTY GHL
-- value).
-- ---------------------------------------------------------------------
alter table public.quotes
  add column if not exists ghl_event_date_pushed text;

comment on column public.quotes.ghl_event_date_pushed is
  'MM/DD/YYYY value last CONFIRMED pushed to GHL''s "Event Date" custom field (ledger #314). Stamped by every push site (send route, quote/route.ts''s date-changing update, the approve route reconcile) on a successful push. Compared against the quote''s current formatted event date to detect "our side changed since the last push" — never compared against GHL''s live value, which would silently revert a staff correction made directly in GHL. Null = legacy/never-confirmed-pushed row.';

-- ---------------------------------------------------------------------
-- job_stock_movements (2026-08-25, migrations/2026-08-25-job-stock-
-- movements.sql, ledger row 386, renamed row 397) — durable, append-only
-- audit of stock taken off / put back on the shelf per JOB PREP OR
-- JOB-CANCEL REVERSAL specifically — it does NOT cover every stock-changing
-- event in the app. prepareJobMaterials's jobs.stock_deductions snapshot and
-- the cancel route's reversal of it are both CLEARED back to null the
-- instant cancel finishes using them (so the same job can be re-prepped
-- later) — this table is the durable record that clearing destroys, written
-- by src/lib/inventory/jobStockMovements.ts's recordJobStockMovements, one
-- row per SKU per prep or cancel-reversal event. Never read/updated/cleared
-- by either caller. Supplier receipts and crew true-ups are NOT written here
-- — they already persist durably elsewhere (inventory_orders.received_lines
-- for receipts, job_material_actuals for true-ups) and never destroyed their
-- own record the way prep/cancel did, so there is no single complete
-- on-hand-movement ledger today; see the migration file's own header for the
-- full reasoning. RLS ENABLED, ZERO POLICIES - service-role only, matching
-- job_segments / job_assignments / shifts / crew_members.
-- ---------------------------------------------------------------------
create table if not exists public.job_stock_movements (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.jobs(id) on delete cascade,
  sku        text not null,

  -- Signed: negative = taken off the shelf (prep), positive = returned
  -- (cancel reversal) — mirrors adjustOnHandAtomic's own signed `delta`
  -- (src/lib/inventory/onHand.ts).
  qty_delta  integer not null,
  before_qty integer not null,
  after_qty  integer not null,

  reason     text not null check (reason in ('prep', 'cancel_reversal')),
  created_at timestamptz not null default now()
);

create index if not exists job_stock_movements_job_id_idx
  on public.job_stock_movements (job_id);

create index if not exists job_stock_movements_created_at_idx
  on public.job_stock_movements (created_at desc);

alter table public.job_stock_movements enable row level security;

-- ---------------------------------------------------------------------
-- Fleet GPS (Bouncie) — ledger row 403 phase 2, capture-only.
-- Source migration: 2026-08-26-bouncie-vehicles.sql (read it for the reasoning).
--
-- These three tables record where the company vehicles are. They deliberately
-- have NO foreign key into job_segments / shifts / jobs: row 403 constraint (a)
-- is that GPS never writes payroll. A geofence may only SUGGEST an arrive or
-- depart to a crew member's own device, and a human still affirmatively taps.
-- ---------------------------------------------------------------------
create table if not exists public.vehicles (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  imei        text,
  vin         text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One device per vehicle, never shared (constraint (c)): the Bouncie
-- subscription and trip history belong to the DEVICE, so moving the truck's
-- tracker into the van would file the van's miles under the truck.
create unique index if not exists vehicles_imei_key
  on public.vehicles (imei) where imei is not null;

create unique index if not exists vehicles_vin_key
  on public.vehicles (vin) where vin is not null;

-- `updated_at` maintenance, matching every other table in this schema that has
-- the column (S68 technical lens: it was declared and then never maintained,
-- which is worse than not having it — it would read as fresh forever).
create or replace function vehicles_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists vehicles_updated_at_trigger on public.vehicles;
create trigger vehicles_updated_at_trigger
  before update on public.vehicles
  for each row execute function vehicles_set_updated_at();

-- The STATIC vehicle-to-crew assignment (constraint (d)) — a setting edited when
-- a crew actually changes, not a daily screen. A vehicle carries a CREW, so the
-- map label holds several names. Whatever reads this must present it as an
-- assumption, never as an assertion about who is physically in the vehicle.
create table if not exists public.vehicle_crew (
  id              uuid primary key default gen_random_uuid(),
  vehicle_id      uuid not null references public.vehicles (id) on delete cascade,
  crew_member_id  uuid not null references public.crew_members (id) on delete cascade,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create unique index if not exists vehicle_crew_vehicle_member_key
  on public.vehicle_crew (vehicle_id, crew_member_id);

create index if not exists vehicle_crew_vehicle_idx
  on public.vehicle_crew (vehicle_id) where active;

-- The raw capture log. Everything but the payload and its hash is NULLABLE on
-- purpose: this table's job is to record what Bouncie ACTUALLY sent, including a
-- payload that does not match the published spec, which is the most valuable
-- thing it can catch. Dedupe is a sha256 of the exact body, because
-- transaction_id identifies a TRIP and many distinct events share one.
create table if not exists public.vehicle_events (
  id              uuid primary key default gen_random_uuid(),
  received_at     timestamptz not null default now(),
  event_type      text,
  imei            text,
  vin             text,
  transaction_id  text,
  occurred_at     timestamptz,

  -- ROW 403 CONSTRAINT (f): off-hours location is not the company's to see.
  -- The truck goes home with an employee, so without this the table quietly
  -- accumulates every evening, weekend and personal errand, forever, at rooftop
  -- precision. Tagging at INSERT is the floor: it costs nothing, it cannot be
  -- forgotten later, and it gives a retention or redaction job something to act
  -- on without re-parsing every payload. NULL means the event carried no usable
  -- timestamp, which is itself a case a purge job must decide about rather than
  -- silently treat as in-hours. The window itself is a business decision, held
  -- in ONE place: BUSINESS_HOURS in src/lib/integrations/bouncie.ts.
  occurred_off_hours boolean,
  body_sha256     text not null,
  payload         jsonb not null
);

create unique index if not exists vehicle_events_body_sha256_key
  on public.vehicle_events (body_sha256);

create index if not exists vehicle_events_imei_received_idx
  on public.vehicle_events (imei, received_at desc);

create index if not exists vehicle_events_transaction_idx
  on public.vehicle_events (transaction_id) where transaction_id is not null;

alter table public.vehicles       enable row level security;
alter table public.vehicle_crew   enable row level security;
alter table public.vehicle_events enable row level security;


-- ---------------------------------------------------------------------
-- Fleet GPS — the SECOND CLOCK, polling shape (ledger row 403).
-- Source migration: 2026-08-28-vehicle-visits-polling.sql (read it for the
-- reasoning; it also names the two superseded geofence migrations that must
-- never be applied). Customer coordinates never leave this database: the
-- quote tool polls the vehicle position and does the proximity maths itself.
--
-- Crew clock in and out by hand and that stays the payroll record. These
-- columns and this table are the independent record compared against it, and
-- there is deliberately NO foreign key from here into shifts or job_segments.
-- ---------------------------------------------------------------------
-- ---------------------------------------------------------------------
-- Last known position per vehicle — what the office map reads.
--
-- Written by the poller on every cycle. `last_seen_at` is Bouncie's own
-- `stats.lastUpdated`, not our poll time, so a stale device shows as stale
-- rather than as freshly parked (row 403 constraint (c): an absent or silent
-- device must read as "no signal", never as "not at the job").
-- ---------------------------------------------------------------------
alter table public.vehicles add column if not exists last_lat double precision;
alter table public.vehicles add column if not exists last_lng double precision;
alter table public.vehicles add column if not exists last_seen_at timestamptz;

-- ---------------------------------------------------------------------
-- vehicle_visits — one row per arrival, derived by proximity.
-- ---------------------------------------------------------------------
create table if not exists public.vehicle_visits (
  id              uuid primary key default gen_random_uuid(),
  vehicle_id      uuid not null references public.vehicles(id) on delete cascade,

  -- What the vehicle was near. 'depot' is the 6 Birch Road day-start anchor and
  -- carries no job; a CHECK keeps the shapes honest so a half-populated row can
  -- never be resolved wrongly.
  kind            text not null check (kind in ('job', 'depot')),
  job_id          uuid references public.jobs(id) on delete set null,
  constraint vehicle_visits_shape check (
    (kind = 'depot' and job_id is null) or (kind = 'job')
  ),

  entered_at      timestamptz not null,
  exited_at       timestamptz,

  -- Naldo's 15-minute rule, applied at CLOSE time and stored rather than
  -- filtered: a below-threshold visit is data about drive-bys and quick stops,
  -- and deleting it would make the radius impossible to tune later.
  below_min_dwell boolean,

  -- The evidence: where the vehicle actually was at entry, straight from the
  -- poll. Replaces webhook-event provenance, and doubles as the record for
  -- tuning the radius (how far from the anchor do real arrivals sit?).
  entered_lat     double precision,
  entered_lng     double precision,

  created_at      timestamptz not null default now()
);

-- "What is open for this vehicle" — the poller's per-cycle lookup. One open
-- visit per vehicle AT MOST, enforced: the poller closes before it opens, and
-- this index makes a bug in that ordering loud instead of silent.
create unique index if not exists vehicle_visits_one_open_per_vehicle
  on public.vehicle_visits (vehicle_id) where exited_at is null;

-- "Every visit to this job, in order" — doubling back shows as two rows.
create index if not exists vehicle_visits_job_idx
  on public.vehicle_visits (job_id, entered_at) where job_id is not null;

-- "What happened that day" — the compare view's read.
create index if not exists vehicle_visits_entered_idx
  on public.vehicle_visits (entered_at desc);

alter table public.vehicle_visits enable row level security;
