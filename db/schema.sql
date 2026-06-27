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
  created_by text
);

-- Backfill for existing installs (pre-dates the audit column).
alter table quotes
  add column if not exists created_by text;

alter table quotes disable row level security;

create index if not exists quotes_created_at_idx on quotes (created_at desc);

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
-- ─────────────────────────────────────────────────────────────

create table if not exists customers (
  id            uuid primary key default gen_random_uuid(),
  match_key     text unique,         -- hl:<id> | email:<lower> | phone:<digits> | name:<lower>
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

alter table customers disable row level security;
alter table properties disable row level security;

create index if not exists customers_hl_contact_id_idx on customers (hl_contact_id) where hl_contact_id is not null;
create index if not exists customers_email_idx on customers (email) where email is not null;
create index if not exists properties_customer_id_idx on properties (customer_id);
create index if not exists quotes_customer_id_idx on quotes (customer_id) where customer_id is not null;

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
