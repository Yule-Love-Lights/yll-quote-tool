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
