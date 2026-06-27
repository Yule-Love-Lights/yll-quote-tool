-- =====================================================================
-- inventory_catalog — full supplier (Thunder Lighting) catalog (#82 Slice 1a).
-- Idempotent; safe to re-run. Paste into the Supabase SQL Editor and Run.
--
-- The raw vendor catalog, imported from Thunder's CSV. Vendor-sourced columns
-- (name, category, color, size, wholesale_cost, needs_adapter, bag_ct, case_ct)
-- are re-seeded on every import; OPERATOR columns are never touched by import:
--   yll_category → operator's re-grouping override (null = use vendor category)
--   locked       → operator's sold-out / unobtainable flag
--
-- Reached only via the service-role client (server API routes), so RLS is
-- disabled to match app_settings / designs / quotes.
-- =====================================================================

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

alter table inventory_catalog disable row level security;

-- Keep updated_at fresh on every write (mirrors app_settings).
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
