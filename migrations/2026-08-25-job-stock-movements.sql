-- =====================================================================
-- job_stock_movements (2026-08-25, ledger row 386, renamed row 397) — durable,
-- append-only audit of stock taken off / put back on the shelf per JOB PREP
-- OR JOB-CANCEL REVERSAL specifically. It does NOT cover every stock-changing
-- event in the app.
--
-- prepareJobMaterials (src/lib/inventory/jobs.ts) persists what it deducted
-- into jobs.stock_deductions, and the cancel route (src/app/api/jobs/[id]/
-- cancel/route.ts) reverses that exact snapshot — but the reversal CLEARS
-- stock_deductions/stock_decremented_at back to null the instant it's used,
-- by design, so the same job can be re-prepped later. That means the record
-- of what prep actually took and what cancel actually returned is destroyed
-- by the very operation whose correctness it exists to make answerable after
-- the fact. This table is the durable replacement for THAT record.
--
-- WHAT THIS TABLE DOES NOT COVER (row 397): the other two on-hand-changing
-- event classes in the app never destroy their own record the way prep/cancel
-- did, so they were deliberately never routed through this table —
--   - supplier receipts (src/lib/inventory/orders.ts, receiveOrder) already
--     persist durably in inventory_orders.received_lines + received_at.
--   - crew true-ups (src/lib/inventory/materialActuals.ts,
--     recordMaterialActuals) already persist durably in
--     job_material_actuals.
-- There is no single table today that answers "why is on-hand for SKU X what
-- it is" across ALL movement classes — that answer requires this table PLUS
-- the two above. Widening this table to also absorb those two would change
-- adjustOnHandAtomic's signature (the shared low-level primitive) for every
-- caller to serve a job-scoped audit table two of its callers don't need —
-- deliberately out of scope here; see src/lib/inventory/jobStockMovements.ts.
--
-- This table is written to by TWO callers only, both via
-- src/lib/inventory/jobStockMovements.ts's recordJobStockMovements — never
-- read, updated, or cleared by either of them, and never touched by the
-- jobs-row nulling above:
--   'prep'            — prepareJobMaterials, one row per SKU actually
--                        deducted (qty_delta negative).
--   'cancel_reversal' — the cancel route, one row per SKU actually returned
--                        (qty_delta positive).
-- Best-effort: a failed insert here never blocks or unwinds the on-hand
-- change it documents (mirrors every other on-hand write site's
-- console.error-and-continue pattern).
--
-- RLS ENABLED, ZERO POLICIES - service-role only, matching job_segments /
-- job_assignments / shifts / crew_members.
--
-- APPLIED TO PROD (2026-08-25, under this file's renamed job_stock_movements
-- table — no stock_movements table was ever created). Verified via direct
-- query: 8 columns, RLS enabled with 0 policies, 0 rows. Per AGENTS.md's
-- migration-application rules this was on the safe/additive allowlist
-- (brand-new table, indexes on an empty table, RLS-enable-zero-policies on
-- that new table); this file stays in the repo as the durable record of the
-- DDL that ran — the CREATE TABLE/INDEX/RLS statements above are exactly
-- what's live.
-- =====================================================================

create table if not exists public.job_stock_movements (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references public.jobs(id) on delete cascade,
  sku        text not null,

  -- Signed: negative = taken off the shelf (prep), positive = returned
  -- (cancel reversal) — mirrors adjustOnHandAtomic's own signed `delta`
  -- (src/lib/inventory/onHand.ts) and StockDeduction's `deducted` sign
  -- convention from the caller's point of view.
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
