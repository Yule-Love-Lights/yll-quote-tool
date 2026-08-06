-- =====================================================================
-- ⚠️ NON-CANONICAL REFERENCE SNAPSHOT — DO NOT TRUST FOR PROD SHAPE ⚠️
--
-- This file is NOT the source of truth. The dated files in migrations/*.sql
-- (45+ of them, applied by hand via the Supabase SQL Editor) are what's
-- actually running on prod. This file is a convenience bootstrap dump that
-- has drifted from them and is known to still be wrong in places (audit
-- #110 wave 2, docs/audit/AUDIT-2026-07.md, findings W2-003/004/005/019).
--
-- migrations/FULL-SCHEMA.sql is a second, ALSO-STALE reference dump (it
-- self-documents its own gaps — missing app_settings, custom_uploads,
-- inventory_catalog, inventory_on_hand, customers, properties, jobs,
-- invoices, and a large chunk of the quotes column set). Neither file is
-- kept in sync with migrations/ mechanically; both are hand-maintained and
-- lag behind. Full regeneration of both from the migration history is
-- tracked as a separate follow-up (audit finding W2-007) — this pass only
-- fixes the four most actively-misleading drifts below, not a full sync.
--
-- Known gaps as of 2026-07-03 (audit #110 wave 2) — do not assume this file
-- is complete beyond these fixes:
--   - (W2-018 fixed) The `designs` table was entirely missing; it's now
--     present below with its full current column set (extra_photos,
--     photo_title, photo_path/_w/_h, satellite_*, seed_analysis, created_by).
--     Still verify against migrations/ before trusting it blindly — this is a
--     hand-maintained snapshot, not a mechanically-generated one.
--   - Missing 8+ newer tables entirely: app_settings, custom_uploads,
--     inventory_catalog, inventory_on_hand, quote_view_events, jobs (present
--     here but may itself drift), invoices, training_examples.
--   - quotes is missing later columns added by migrations after this file's
--     last refresh (e.g. valor_* payment fields, ghl_stage_synced_at,
--     approval_notify_* — see migrations/ for the full, current list).
--
-- If you need the REAL current shape of a table: read the dated migration
-- files in migrations/, newest-first, for that table name. If you're
-- provisioning a fresh DB: prefer migrations/FULL-SCHEMA.sql (also stale,
-- but more complete) and then replay any migrations dated after its last
-- refresh, rather than trusting this file alone.
-- =====================================================================

create table if not exists quotes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone default now(),
  customer_name text not null,
  customer_address text not null,
  customer_phone text,
  customer_email text,
  inputs jsonb not null,
  result jsonb not null,
  total numeric(10, 2) not null,
  -- Actor attribution (ledger #81/#90). Written by src/lib/quotes.ts
  -- saveQuote (and designs.ts createDesign for the designs table). Applied to
  -- provisioned DBs by migrations/2026-06-28-add-created-by.sql — this is the
  -- operator's Supabase Auth user id, nullable (pre-auth-gate rows, or an
  -- unauthenticated request, get NULL). ON DELETE SET NULL so removing an
  -- operator account doesn't delete their quotes.
  created_by uuid references auth.users(id) on delete set null,

  -- ── Jobber-flow status spine (ledger #83 Phase 1) ──────────────────────────
  -- Explicit lifecycle status + portal decline reason + sequential display
  -- number (Quote #). Applied to live/provisioned DBs by
  -- migrations/2026-06-27-quote-status.sql (which also creates quote_number_seq
  -- + the allocate_display_number RPC + backfills status). This block mirrors
  -- those columns for a fresh-DB bootstrap. status is free text (canonical set
  -- enforced in code: src/lib/quoteStatus.ts).
  status text,
  decline_reason text,
  quote_number int
);

-- Backfill for existing installs (pre-dates the audit column).
alter table quotes
  add column if not exists created_by uuid references auth.users(id) on delete set null;

-- Jobber-flow status spine backfill (ledger #83 Phase 1) — see
-- migrations/2026-06-27-quote-status.sql for the authoritative migration
-- (sequence + RPC + status backfill from timestamps).
alter table quotes
  add column if not exists status text;
alter table quotes
  add column if not exists decline_reason text;
alter table quotes
  add column if not exists quote_number int;

-- Test Quote flag (ledger #93) — see migrations/2026-06-28-quotes-add-is-test.sql.
-- Fully-simulated test data; jobs/invoices derive is_test via the quote link.
alter table quotes
  add column if not exists is_test boolean not null default false;
create index if not exists quotes_is_test_idx on quotes (is_test);

-- RLS ENABLED, no policies (#90 defense in depth) — every app path uses the
-- service-role client (bypasses RLS); anon/authenticated get nothing. See
-- migrations/2026-06-28-enable-rls-all-tables.sql (the authoritative enable).
alter table quotes enable row level security;

create index if not exists quotes_created_at_idx on quotes (created_at desc);

-- ─────────────────────────────────────────────────────────────
-- designs — design-tool integration (Path B), task #27 Phase 1. Added by this
-- audit fix (W2-018) — this table was entirely missing from db/schema.sql, so
-- a fresh bootstrap from this file alone would 500 on every design read/write.
-- Canonical fresh-install mirror of migrations/2026-06-05-designs.sql +
-- 2026-06-12-training-examples.sql (designs half) + 2026-06-28-add-created-by.sql
-- (designs half) + 2026-07-02-designs-extra-photos.sql + 2026-07-02-designs-
-- photo-title.sql. One editable on-photo light design (the `scene` jsonb is the
-- design tool's Scene shape: yardsticks + items + brightness). A design is an
-- INDEPENDENT record with its own id and an OPTIONAL link to a quote, so it can
-- exist before a quote is saved (the builder creates it when the Street View
-- photo is pulled) and even with no quote at all. The quote link is set when
-- the operator clicks "Calculate Quote".
-- ─────────────────────────────────────────────────────────────

create table if not exists designs (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid references quotes(id) on delete set null,
  photo_path text,                                          -- Storage path: {designId}/photo.<ext>
  photo_w integer,
  photo_h integer,
  scene jsonb not null default '{"yardsticks":[],"items":[]}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Analysis provenance + satellite context (#8 Stage A): the AI's raw
  -- analysis from the last analyze, the satellite image it measured against
  -- (path in the designs bucket + dims + deterministic feet-per-pixel), and
  -- the staff's final satellite measurement polylines.
  seed_analysis jsonb,
  satellite_path text,
  satellite_w integer,
  satellite_h integer,
  satellite_feet_per_pixel numeric,
  satellite_lines jsonb,
  -- Actor audit trail (#81/#90) — the operator's Supabase Auth user id.
  created_by uuid references auth.users(id) on delete set null,
  -- #13 multi-image quoting: extra street photos on a design. One design
  -- still owns ONE base photo (photo_path); extras live in a JSONB array of
  -- { id, path, w, h, title? } whose storage objects sit under the same
  -- `{designId}/` prefix (extra-<id>.<ext>).
  extra_photos jsonb,
  -- #13: a staff title for the BASE photo (renameable "Photo 1" tab, like the
  -- extras' own titles). Nullable — null renders as "Photo 1".
  photo_title text
);

-- RLS ENABLED, no policies (#90 defense in depth) — see
-- migrations/2026-06-28-enable-rls-all-tables.sql (the authoritative enable).
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

-- Storage bucket for design artifacts (base house photo + custom-item images).
-- Private; reads go through service-role signed URLs (same pattern as renders).
insert into storage.buckets (id, name, public)
values ('designs', 'designs', false)
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────
-- SHARED jobs table — #83 billing fields + #82 fulfillment_stage.
-- Canonical fresh-install mirror of migrations/2026-06-27-jobs.sql (the
-- authoritative migration: creates job_number_seq, extends the
-- allocate_display_number RPC, indexes + updated_at trigger). ONE jobs table
-- for BOTH epics — the deposit-paid Valor webhook is the SINGLE creator
-- (src/lib/jobs.ts createJobFromQuote, idempotent on quote_id); #82 EXTENDS the
-- same row (fulfillment_stage / design_id → materials), never inserts a second.
-- See docs/jobber-flow/SPEC.md §3,§5 (#83) + the inventory-82 design §47,§119-123
-- (#82). status free text (canonical set in src/lib/jobs.ts).
-- ⚠️ This block is for fresh-DB bootstrap only; the .sql migration is what is
-- applied to provisioned DBs. ⚠️ Inventory (#82 Slice 3) also touches this block
-- — keep it isolated so a merge doesn't tangle the two epics' edits.
-- ─────────────────────────────────────────────────────────────

create table if not exists jobs (
  id            uuid primary key default gen_random_uuid(),
  job_number    int unique,                          -- Job # display (≠ Quote ID), from job_number_seq
  quote_id      uuid references quotes(id) on delete cascade, -- From-Quote link; cascade so deleteQuote/"delete all" doesn't FK-fail
  design_id     uuid,                                -- #82: design → materials projection
  customer_id   uuid,                                -- #83 Phase 5 (customers table) — nullable now
  property_id   uuid,                                -- #83 Phase 5 (properties table) — nullable now
  type          text not null default 'one_off',     -- one_off | permanent (from quote service_type)
  status        text not null default 'to_schedule', -- #83 BILLING: to_schedule→scheduled→installed→requires_invoicing→done (+cancelled)
  fulfillment_stage text,                            -- ⚠️ #82 owns this — materials Kanban axis; #83 leaves NULL
  line_items    jsonb,                               -- snapshot of the quote's priced line items
  install_date  date,                                -- synced from home.works later (#84)
  completed_at  timestamptz,                         -- install-complete (#83 invoice trigger, Phase 3)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- RLS ENABLED, no policies (#90) — see migrations/2026-06-28-enable-rls-all-tables.sql.
alter table jobs enable row level security;

create unique index if not exists jobs_quote_id_key on jobs (quote_id) where quote_id is not null;
create index if not exists jobs_created_at_idx on jobs (created_at desc);
create index if not exists jobs_status_idx on jobs (status);

-- ─────────────────────────────────────────────────────────────
-- Invoices — money tail of the Jobber-flow (ledger #83 Phase 3). Auto-created
-- when a job is installed/complete: full total with the actually-paid deposit
-- (quotes.deposit_amount_usd) applied → balance = max(0, total − deposit).
-- Canonical fresh-install mirror of migrations/2026-06-27-invoices.sql (the
-- authoritative migration also adds invoice_number_seq + extends the
-- allocate_display_number allowlist + indexes + updated_at trigger). status free
-- text (canonical set in src/lib/invoiceStatus.ts). ⚠️ Fresh-DB bootstrap only.
-- ─────────────────────────────────────────────────────────────

create table if not exists invoices (
  id              uuid primary key default gen_random_uuid(),
  invoice_number  int unique,                          -- Invoice # display, from invoice_number_seq
  job_id          uuid references jobs(id) on delete cascade,   -- one invoice per job; cascade so quote/job delete doesn't FK-fail
  quote_id        uuid references quotes(id) on delete cascade, -- From-Quote link
  customer_id     uuid,                                -- #83 Phase 5 identity (carried from the job)
  subtotal        numeric(10, 2) not null default 0,
  discount        numeric(10, 2) not null default 0,
  tax             numeric(10, 2) not null default 0,   -- 0 when tax_overridden
  total           numeric(10, 2) not null default 0,
  deposit_applied numeric(10, 2) not null default 0,   -- actually-paid deposit, not a recomputed 50%
  balance         numeric(10, 2) not null default 0,   -- max(0, total − deposit_applied)
  credit_note     numeric(10, 2) not null default 0,   -- overpayment (deposit > total) → manual Valor refund
  tax_overridden  boolean not null default false,
  status          text not null default 'draft',       -- draft → awaiting_payment → paid (+ cancelled)
  valor_balance_txn_id text,
  valor_receipt_url    text,
  created_at      timestamptz not null default now(),
  paid_at         timestamptz,
  updated_at      timestamptz not null default now()
);

-- RLS ENABLED, no policies (#90) — see migrations/2026-06-28-enable-rls-all-tables.sql.
alter table invoices enable row level security;

create unique index if not exists invoices_job_id_key on invoices (job_id) where job_id is not null;
create index if not exists invoices_created_at_idx on invoices (created_at desc);
create index if not exists invoices_status_idx on invoices (status);

-- ─────────────────────────────────────────────────────────────
-- Customer + Property identity (ledger #83, Phase 5). Stable customer object
-- (today loose-matched per-quote by HL contact→email→phone→name) with
-- one-or-more properties; quotes reference both. Powers "rebook last season".
-- Canonical fresh-install mirror of migrations/2026-06-27-customers-properties.sql
-- (the authoritative migration — also adds indexes + updated_at triggers + the
-- quotes.customer_id/property_id columns). Populated in code
-- (src/lib/customers.ts backfillCustomersFromQuotes), not by SQL.
-- ⚠️ Fresh-DB bootstrap only; the .sql migration is what is applied to
-- provisioned DBs. match_key is the computed dedup key (unique).
-- #213: an identity that doesn't clear the adoption bar (src/lib/
-- customers.ts classifyCandidate) gets a NEW row keyed
-- dup:[["label","value"],...] (JSON-encoded) instead of one of the four
-- shapes below — still unique, still race-safe.
-- ─────────────────────────────────────────────────────────────

create table if not exists customers (
  id            uuid primary key default gen_random_uuid(),
  match_key     text unique,         -- hl:<id> | email:<lower> | phone:<digits> | name:<lower> | dup:[...]
  hl_contact_id text,
  name          text,
  email         text,
  phone         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists properties (
  id           uuid primary key default gen_random_uuid(),
  customer_id  uuid not null references customers(id) on delete cascade,
  address      text,
  address_key  text not null,        -- normalized address; unique within a customer
  lat          double precision,
  lng          double precision,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (customer_id, address_key)
);

alter table quotes add column if not exists customer_id uuid references customers(id) on delete set null;
alter table quotes add column if not exists property_id uuid references properties(id) on delete set null;

-- RLS ENABLED, no policies (#90) — see migrations/2026-06-28-enable-rls-all-tables.sql.
alter table customers enable row level security;
alter table properties enable row level security;

create index if not exists customers_hl_contact_id_idx on customers (hl_contact_id) where hl_contact_id is not null;
create index if not exists customers_email_idx on customers (email) where email is not null;
create index if not exists properties_customer_id_idx on properties (customer_id);
create index if not exists quotes_customer_id_idx on quotes (customer_id) where customer_id is not null;

-- ─────────────────────────────────────────────────────────────
-- Photo corrections — REMOVED (S13, migrations/2026-06-25-drop-photo-corrections.sql).
-- The "corrections" system is fully retired, superseded by the
-- training_examples few-shot library (#8 Stage A). Table dropped; nothing in
-- the app reads/writes it. Left as a tombstone comment (not re-created) so a
-- fresh bootstrap from this file matches prod. Do NOT re-add this table.
-- ─────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────
-- Training houses — historical jobs with known final measurements.
-- Higher-quality ground truth than corrections (you installed & took
-- them down, so you know exactly what went where).
-- ─────────────────────────────────────────────────────────────

create table if not exists training_houses (
  id uuid primary key default gen_random_uuid(),
  created_at timestamp with time zone default now(),

  -- Identification / context
  address text,
  year_completed integer,
  house_style text,              -- "cape", "colonial", "ranch", "custom", etc.
  notes text,

  -- Multiple photos per house with tags.
  -- [{ tag: "front_install" | "front_takedown" | "side" | "satellite" | ..., base64, mediaType }]
  photos jsonb not null default '[]'::jsonb,

  -- Roofline
  santas_footage numeric(10, 2),
  santas_difficulty text,
  santas_lines jsonb default '[]'::jsonb,

  gingerbread_footage numeric(10, 2),
  gingerbread_difficulty text,
  gingerbread_lines jsonb default '[]'::jsonb,

  -- Garland + C9 custom-run detections (migrations/2026-04-22-add-correction-fields.sql;
  -- mirrors the same columns on photo_corrections before that table was dropped).
  garland_detections jsonb,
  c9_lines jsonb,

  winter_wonderland_footage numeric(10, 2),
  winter_wonderland_difficulty text,

  -- Stake Lighting — independent staked ground runs (migrations/2026-06-26-add-stake-lighting-training.sql),
  -- parallel of the winter_wonderland_* columns above.
  stake_lighting_footage numeric(10, 2),
  stake_lighting_difficulty text,   -- 'easy' | 'medium' | 'hard' (enum enforced in app code)
  stake_lines jsonb,

  -- Mini lights (bushes / trees / columns)
  mini_light_detections jsonb not null default '[]'::jsonb,

  -- Other decor — quantities + spec
  spritzers jsonb not null default '[]'::jsonb,
  wreaths jsonb not null default '[]'::jsonb,
  garland jsonb not null default '[]'::jsonb
);

-- Backfill for existing installs (garland/C9 detections + Stake Lighting —
-- see migrations/2026-04-22-add-correction-fields.sql and
-- migrations/2026-06-26-add-stake-lighting-training.sql).
alter table training_houses
  add column if not exists garland_detections jsonb,
  add column if not exists c9_lines jsonb,
  add column if not exists stake_lighting_footage numeric(10, 2),
  add column if not exists stake_lighting_difficulty text,
  add column if not exists stake_lines jsonb;

-- RLS ENABLED, no policies (#90) — see migrations/2026-06-28-enable-rls-all-tables.sql.
alter table training_houses enable row level security;

create index if not exists training_houses_created_at_idx on training_houses (created_at desc);
create index if not exists training_houses_address_idx on training_houses (address);
