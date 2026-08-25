-- =====================================================================
-- stock_movements (2026-08-25, ledger row 386) — durable, append-only audit
-- of stock taken off / put back on the shelf per job.
--
-- prepareJobMaterials (src/lib/inventory/jobs.ts) persists what it deducted
-- into jobs.stock_deductions, and the cancel route (src/app/api/jobs/[id]/
-- cancel/route.ts) reverses that exact snapshot — but the reversal CLEARS
-- stock_deductions/stock_decremented_at back to null the instant it's used,
-- by design, so the same job can be re-prepped later. That means the record
-- of what prep actually took and what cancel actually returned is destroyed
-- by the very operation whose correctness it exists to make answerable after
-- the fact. No durable stock-movement/audit table existed anywhere in the
-- schema before this one.
--
-- This table is written to by TWO callers only, both via
-- src/lib/inventory/stockMovements.ts's recordStockMovements — never read,
-- updated, or cleared by either of them, and never touched by the
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
-- HOW TO APPLY: this migration is INTENTIONALLY LEFT UNAPPLIED by this PR
-- (see AGENTS.md's migration-application rules and docs/context/
-- task_ledger.md row 386) — the CREATE TABLE itself is on the safe/additive
-- allowlist (brand-new table, indexes on an empty table, RLS-enable-zero-
-- policies on that new table), but leaving code + migration to land together
-- and apply once the PR is reviewed keeps this change auditable end-to-end.
-- =====================================================================

create table if not exists public.stock_movements (
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

create index if not exists stock_movements_job_id_idx
  on public.stock_movements (job_id);

create index if not exists stock_movements_created_at_idx
  on public.stock_movements (created_at desc);

alter table public.stock_movements enable row level security;
