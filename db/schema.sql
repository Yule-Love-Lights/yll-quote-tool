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
