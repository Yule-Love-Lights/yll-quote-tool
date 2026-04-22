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
  notes text
);

alter table photo_corrections disable row level security;

create index if not exists photo_corrections_created_at_idx on photo_corrections (created_at desc);
