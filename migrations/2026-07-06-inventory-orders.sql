-- =====================================================================
-- inventory_orders — on-order ledger for the supplier auto purchase order
-- (P8, folds in #110 W7-002). One row per SENT purchase order. Recording an
-- order BEFORE the future demand calc subtracts it (buildSupplierPurchaseOrder),
-- so a re-send lists only the NEW shortfall, not the full cumulative one.
-- `lines` = [{sku, name, qty}] as ordered; `received_lines` = [{sku, qty}] set
-- at receive time (may differ from `lines` on a short shipment). RLS-disabled
-- to match the rest of the inventory tables (inventory_on_hand, inventory_catalog).
-- Idempotent; safe to re-run. Paste into the Supabase SQL Editor and Run.
-- =====================================================================
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

alter table inventory_orders disable row level security;

create index if not exists inventory_orders_status_open_idx
  on inventory_orders (status)
  where status = 'open';
