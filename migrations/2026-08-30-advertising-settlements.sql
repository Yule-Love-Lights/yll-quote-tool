-- =====================================================================
-- Advertising payout settlement (ledger row 481, Naldo's 2026-08-30
-- rulings). The tool already knows what every worker has EARNED (the rate
-- stamped on each accepted photo). Nothing recorded that the money was
-- HANDED OVER, so the pay screen showed a cumulative earned figure forever.
--
-- A settlement says WHICH photos it paid, not just "week of Aug 24, $47.50",
-- because a photo inside an already-paid week can be accepted days later and
-- period-only settlement cannot then tell an underpayment from a late
-- acceptance.
--
-- advertising_settlements: one payment handed to one worker. total_cents is
-- the sum of its lines, asserted in the data layer at write time.
--   * method (Naldo 2026-08-30): a fixed short list, so "how much did we
--     pay in cash this month" stays answerable. Free text goes in note.
--   * total_cents > 0: a $0.00 payment is not a record of anything, and
--     refusing it at the database means an empty selection can never write
--     one even if the data layer's own guard were removed.
--
-- advertising_settlement_lines: which photos that payment covered.
--   * placement_id UNIQUE is the whole safety property: a photo can be paid
--     at MOST ONCE, enforced by the database rather than by remembering. A
--     double-submitted "Mark paid" loses its race here and surfaces as a
--     named conflict.
--   * amount_cents copies the placement's STAMPED accepted_rate_cents at
--     settle time, so the settlement is its own record even if anything
--     upstream later changes.
--   * The placement FK is left at its default (no action / restrict): a
--     payment record must never lose the subject it paid for. Placements
--     are voided, never deleted, so nothing in the app hits this.
--   * The settlement FK cascades: deleting a settlement (which the app
--     only does to unwind its own failed write) takes its lines with it,
--     so a half-written payment can never be left behind.
--
-- Unpaid is DERIVED, never stored: accepted earned cents minus the sum of
-- that worker's settlement lines. Same posture as the sign balance and as
-- `remaining` in signIssuances.ts, so it cannot drift.
--
-- RLS ENABLED, ZERO POLICIES on both new tables (service-role only, the
-- advertising default). HOW TO APPLY: safe/additive per AGENTS.md — two
-- brand-new tables, indexes that cannot collide with existing data, and
-- RLS-enable on brand-new tables only.
-- =====================================================================

create table if not exists public.advertising_settlements (
  id           uuid primary key default gen_random_uuid(),
  worker_id    uuid not null references public.advertising_workers(id),
  total_cents  integer not null check (total_cents > 0),
  method       text not null check (method in ('cash', 'venmo', 'check', 'other')),
  note         text,
  paid_at      timestamptz not null default now(),
  paid_by      uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now()
);

create index if not exists advertising_settlements_worker_idx
  on public.advertising_settlements (worker_id, paid_at desc);

create table if not exists public.advertising_settlement_lines (
  id             uuid primary key default gen_random_uuid(),
  settlement_id  uuid not null references public.advertising_settlements(id) on delete cascade,
  placement_id   uuid not null references public.advertising_placements(id),
  amount_cents   integer not null check (amount_cents >= 0),
  created_at     timestamptz not null default now()
);

-- A placement is payable at most once. This index IS the guarantee.
create unique index if not exists advertising_settlement_lines_placement_key
  on public.advertising_settlement_lines (placement_id);

create index if not exists advertising_settlement_lines_settlement_idx
  on public.advertising_settlement_lines (settlement_id);

alter table public.advertising_settlements enable row level security;
alter table public.advertising_settlement_lines enable row level security;
