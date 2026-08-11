-- =====================================================================
-- shift_breaks - unpaid break tracking on the shifts clock ledger
-- (Operations Hub Flow B, Track A Phase 2).
--
-- One row per break. `shift_id` ties it to the day envelope in `shifts`;
-- `crew_member_id` is denormalized from that shift so a break can be
-- authorized and queried without a join, and it is what the write path
-- checks before touching a row.
--
-- Breaks are UNPAID (contract section 8: paid seconds are the union of
-- paid-day intervals "excluding unpaid breaks"), so paid time for a shift is
-- the clock envelope MINUS break time. That subtraction feeds P4P payout
-- math; the arithmetic lives in src/lib/shiftBreaks.ts with its own tests.
--
-- The DB, not a read-then-check, enforces at most one OPEN break per shift:
-- a partial unique index on shift_id where ended_at is null. Same shape as
-- `shifts_one_open_per_person`, and the write path recovers the winner on
-- 23505 so a concurrent double-tap is idempotent rather than an error.
--
-- `source` records how the break was STARTED; `end_source` how it was ENDED
-- (nullable while running). They can differ, per the contract's audit rule
-- that both ends of a consequential action carry their own source.
--
-- `auto_closed` marks a break that a clock-out ended rather than the crew
-- member. Flow B says clock-out "closes any open segment/break at punch time
-- and flags review", and this column is what feeds the `open_break` time
-- exception queue. It is NOT an error state; it is a review state.
--
-- RLS ENABLED, ZERO POLICIES - service-role only for now. Matches the
-- crew_members / shifts pattern and fails closed until the Flow B routes and
-- policies ship.
--
-- HOW TO APPLY: safe/additive per AGENTS.md's migration-application default
-- (a brand-new table + indexes + RLS-with-zero-policies on that new table),
-- so it applies directly via Supabase MCP without waiting for a merge.
-- APPLIED to prod 2026-08-11 (S58) and verified by real queries, not by the
-- tool's success message: 11 columns with the expected types/defaults, the
-- partial unique index present with its `WHERE (ended_at IS NULL)` predicate,
-- RLS enabled with 0 policies, and both the check constraint and the
-- updated_at trigger in place.
-- =====================================================================

create table if not exists public.shift_breaks (
  id              uuid primary key default gen_random_uuid(),
  shift_id        uuid not null references public.shifts(id),
  crew_member_id  uuid not null references public.crew_members(id),
  started_at      timestamptz not null default now(),
  ended_at        timestamptz,
  source          text not null check (source in ('pwa', 'telegram', 'office', 'system')),
  end_source      text check (end_source in ('pwa', 'telegram', 'office', 'system')),
  auto_closed     boolean not null default false,
  device_time     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- A break cannot end before it began. Guards against an office correction
  -- typo minting negative break time, which would silently OVERPAY the day.
  constraint shift_breaks_ends_after_start check (ended_at is null or ended_at >= started_at)
);

create unique index if not exists shift_breaks_one_open_per_shift
  on public.shift_breaks (shift_id) where ended_at is null;

create index if not exists shift_breaks_shift_id_idx
  on public.shift_breaks (shift_id);

create index if not exists shift_breaks_crew_member_id_idx
  on public.shift_breaks (crew_member_id);

alter table public.shift_breaks enable row level security;

create or replace function public.shift_breaks_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists shift_breaks_updated_at on public.shift_breaks;
create trigger shift_breaks_updated_at
  before update on public.shift_breaks
  for each row execute function public.shift_breaks_set_updated_at();
