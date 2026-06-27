-- =====================================================================
-- inventory_on_hand — curated warehouse stock list (#82 Slice 1c).
-- One row per stocked SKU. `sku` logically refs inventory_catalog.sku (the app
-- only adds SKUs picked from the catalog). RLS-disabled to match inventory_catalog;
-- reuses the inventory_set_updated_at() trigger fn from the catalog migration.
-- Idempotent; safe to re-run. Paste into the Supabase SQL Editor and Run.
-- =====================================================================
create table if not exists inventory_on_hand (
  sku              text primary key,
  on_hand_qty      integer not null default 0,
  reorder_point    integer not null default 0,
  storage_location text,
  updated_at       timestamptz not null default now()
);

alter table inventory_on_hand disable row level security;

drop trigger if exists inventory_on_hand_updated_at_trigger on inventory_on_hand;
create trigger inventory_on_hand_updated_at_trigger
  before update on inventory_on_hand
  for each row execute function inventory_set_updated_at();
