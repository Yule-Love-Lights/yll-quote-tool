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
  -- Audit fix (g29-route): actor attribution, RESERVED for the operator-auth
  -- work (ledger #81). ⚠️ NOT written by any code yet — the data layer
  -- (src/lib/quotes.ts saveQuote/updateQuote) does NOT set it, and there is NO
  -- standalone migrations/*.sql applying it to already-provisioned DBs, so PROD
  -- does NOT have this column. Do NOT INSERT/UPDATE created_by until #81 ships
  -- BOTH the writing code AND a migrations/2026-xx-quotes-add-created-by.sql
  -- together — writing it before the migration would 500 every saveQuote /
  -- updateQuote on prod. Free-text so it can hold an operator id/email later.
  created_by text,

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
  add column if not exists created_by text;

-- Jobber-flow status spine backfill (ledger #83 Phase 1) — see
-- migrations/2026-06-27-quote-status.sql for the authoritative migration
-- (sequence + RPC + status backfill from timestamps).
alter table quotes
  add column if not exists status text;
alter table quotes
  add column if not exists decline_reason text;
alter table quotes
  add column if not exists quote_number int;

alter table quotes disable row level security;

create index if not exists quotes_created_at_idx on quotes (created_at desc);

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

alter table jobs disable row level security;

create unique index if not exists jobs_quote_id_key on jobs (quote_id) where quote_id is not null;
create index if not exists jobs_created_at_idx on jobs (created_at desc);
create index if not exists jobs_status_idx on jobs (status);

-- ─────────────────────────────────────────────────────────────
-- Photo corrections — user-edited measurements feed back as
-- few-shot examples to improve future Claude Vision analyses.
-- ─────────────────────────────────────────────────────────────

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

-- Backfill for existing installs
alter table photo_corrections
  add column if not exists corrected_mini_light_detections jsonb not null default '[]'::jsonb;

alter table photo_corrections disable row level security;

create index if not exists photo_corrections_created_at_idx on photo_corrections (created_at desc);

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

  winter_wonderland_footage numeric(10, 2),
  winter_wonderland_difficulty text,

  -- Mini lights (bushes / trees / columns)
  mini_light_detections jsonb not null default '[]'::jsonb,

  -- Other decor — quantities + spec
  spritzers jsonb not null default '[]'::jsonb,
  wreaths jsonb not null default '[]'::jsonb,
  garland jsonb not null default '[]'::jsonb
);

alter table training_houses disable row level security;

create index if not exists training_houses_created_at_idx on training_houses (created_at desc);
create index if not exists training_houses_address_idx on training_houses (address);
