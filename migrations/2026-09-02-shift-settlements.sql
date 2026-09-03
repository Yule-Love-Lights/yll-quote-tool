-- =====================================================================
-- Shift settlements — time-tracking plan phase 3, ledger row 459.
-- Jason's ruling 2026-09-02.
--
-- WHAT THIS IS. Jason's workflow: "we pay them via another website/cash/bank
-- transfer, and THEN we mark the hours as approved." So the tool records
-- payments; it does not calculate them. `total_cents` is the amount an admin
-- says was actually handed over. The tool never computes it.
--
-- WHY NOT COMPUTE IT. Overtime has no formula here: ledger row 285 parks the
-- regular-rate treatment pending an accountant, and the case is already live
-- rather than hypothetical — one person logged 50h 55m in the seven days to
-- 2026-09-02, so any flat-rate figure would be wrong for a real week that
-- exists in the data today. Recording what was paid sidesteps that entirely.
-- The per-line hours and rate below are a REFERENCE for the admin's eye, and
-- are stamped so they stay true to the moment of payment.
--
-- THE MODEL, mirroring advertising_settlements (ledger row 481, PR #1130)
-- rather than inventing a second money-approval mechanism in one codebase:
--
--   * A settlement says WHICH SHIFTS it paid, one line each — not "week of
--     Aug 24, $1,350". A shift inside an already-paid week can be corrected
--     days later, and period-only approval cannot then tell an underpayment
--     from a late correction. A line-based one can.
--   * SETTLED and UNSETTLED are DERIVED, never stored. A stored balance
--     drifts; a derived one cannot.
--   * A void is an OVERLAY, not a delete: the row stays as the record of
--     what was recorded, stops counting, and releases its shifts.
--
-- WHAT IT UNBLOCKS. Row 459 has been parked since PR #1062 waiting for a
-- paid marker to exist so that `adminUpdateShiftTimes` and `adminVoidShift`
-- can refuse to rewrite a shift somebody has already been paid for. This is
-- that marker. The guard itself lives at the state change in shifts.ts.
--
-- HOW TO APPLY. On the AGENTS.md safe/additive allowlist and applied
-- directly: two brand-new `create table if not exists`, new indexes on
-- tables with no rows, and RLS enabled with zero policies on brand-new
-- tables only. Nothing existing is altered, dropped or re-indexed — the
-- partial unique index is created in its final shape here, so unlike the
-- advertising void migration there is no index to drop and recreate.
-- =====================================================================

create table if not exists public.shift_settlements (
  id              uuid primary key default gen_random_uuid(),
  crew_member_id  uuid not null references public.crew_members(id),
  -- The amount ACTUALLY handed over, typed by an admin. Positive: a
  -- settlement recording nothing is not a payment, it is a mistake.
  total_cents     integer not null check (total_cents > 0),
  -- Same fixed vocabulary as advertising settlements, so "how much did we
  -- pay in cash this month" stays answerable across both. Anything else goes
  -- in the note.
  method          text not null check (method in ('cash', 'venmo', 'check', 'other')),
  note            text,
  paid_at         timestamptz not null default now(),
  -- TEXT, not a uuid into auth.users, matching `shifts.manual_by`: every
  -- other human stamp on this feature is "Name (email)" so a renamed or
  -- removed account still reads. The advertising table chose a uuid; these
  -- two stamps sit side by side on payroll screens, and matching the
  -- neighbour that shares the row matters more than matching the cousin
  -- that does not.
  paid_by         text,
  created_at      timestamptz not null default now(),
  -- Void overlay, same posture as advertising (row 492).
  voided_at       timestamptz,
  voided_by       text,
  void_reason     text
);

create index if not exists shift_settlements_crew_idx
  on public.shift_settlements (crew_member_id, paid_at desc);

create table if not exists public.shift_settlement_lines (
  id                   uuid primary key default gen_random_uuid(),
  settlement_id        uuid not null references public.shift_settlements(id) on delete cascade,
  shift_id             uuid not null references public.shifts(id),
  -- REFERENCE ONLY, stamped at the moment of payment. The settlement's
  -- total_cents is the money record; these three say what the hours looked
  -- like when it was paid, so a later correction to the shift, or a change
  -- to the person's rate, cannot rewrite history.
  --
  -- reference_cents = round(paid_seconds * rate_cents_per_hour / 3600),
  -- nearest cent. It is NOT asserted to equal the settlement total, because
  -- the whole point is that the two can differ: overtime, a rounded-up cash
  -- payment, an advance, a deduction agreed off-system.
  paid_seconds         integer not null check (paid_seconds >= 0),
  rate_cents_per_hour  integer not null check (rate_cents_per_hour >= 0),
  reference_cents      integer not null check (reference_cents >= 0),
  -- Mirrors the settlement's stamp, written in the same call. A partial
  -- index cannot reference another table, so the void marker has to live
  -- here for the index below to release a voided payment's shifts.
  voided_at            timestamptz,
  created_at           timestamptz not null default now()
);

-- A shift is paid at most once. THIS INDEX IS THE GUARANTEE — not the
-- application check, which is a read that can go stale between two admins.
-- Narrowed to LIVE lines so voiding a payment makes its shifts payable again.
create unique index if not exists shift_settlement_lines_shift_key
  on public.shift_settlement_lines (shift_id) where voided_at is null;

create index if not exists shift_settlement_lines_settlement_idx
  on public.shift_settlement_lines (settlement_id);

-- Zero policies: service-role only, like every other payroll table here.
-- Both tables are brand new, so nothing an anon or authenticated client
-- reads today can break.
alter table public.shift_settlements enable row level security;
alter table public.shift_settlement_lines enable row level security;
