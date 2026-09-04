-- =====================================================================
-- Pay rates CHANGE, and until now every money-to-hours conversion assumed
-- they never had. Ledger row 506; spec in project_time_tracking.md Part 3.
--
-- WHAT IS WRONG TODAY, measured against prod on 2026-09-04 rather than
-- imagined. `crew_members.base_rate_cents` is ONE number -- the rate right
-- NOW -- and since the 2026-09-03 rollover it is what a payment is DIVIDED
-- by to work out which hours the money bought. Jason's stored rate is
-- $16.00/h; his oldest unpaid shift is 21 Aug 2026, which sits inside his
-- $13.00/h window. Paying him today converts the money at $16.00 and marks
-- off about 19% FEWER hours than it actually bought, silently, with nothing
-- on any screen to say so. The same applies to anybody who has had a raise.
--
-- His real history, from him:
--     (beginning) .. 11 Aug 2026   $10.00/h
--     12 Aug 2026 .. 31 Aug 2026   $13.00/h
--      1 Sep 2026 .. today         $16.00/h
--
-- WHAT THIS TABLE IS. One row per rate change: "from this ET calendar day
-- onward, this person is paid this much". The rate for a shift is the row
-- with the greatest `effective_from` that is <= the ET day the shift
-- STARTED -- the same day-bucketing rule the hours pages already use, so a
-- shift spanning midnight takes the rate of the day it began on.
--
-- WHAT IT IS NOT. It is NOT the record of what anybody was PAID. That is
-- `shift_settlement_lines.rate_cents_per_hour`, stamped at payment time and
-- deliberately untouched by this migration. Editing this history therefore
-- cannot rewrite a payment that has already been recorded; it changes what
-- FUTURE conversions do and nothing else. That is what makes entering
-- Jason's two earlier rates safe to do after his $1.00 test payment
-- already exists.
--
-- `crew_members.base_rate_cents` STAYS, and stays the current rate: about
-- forty consumers read it, nearly all of them display. It is kept in step
-- by construction rather than by discipline -- every write goes through
-- `setRateFrom` in src/lib/crewMemberRates.ts, which writes the history row
-- and then recomputes the column as the rate in force TODAY. Nothing else
-- may write the column.
--
-- HOW TO APPLY. This one IS on the AGENTS.md safe/additive allowlist:
-- `create table if not exists`, a new index on a table with no rows yet,
-- and an idempotent seed guarded by `where not exists`. Nothing existing is
-- altered, dropped, or re-typed. Applied directly, then verified by query.
--
-- THE SEED IS DELIBERATELY BEHAVIOUR-PRESERVING. Every person gets one row
-- at their CURRENT rate effective from 2000-01-01, so on the day this ships
-- every conversion resolves to exactly the number it resolved to before and
-- nothing moves. Jason's two earlier rates are then entered by hand through
-- the new screen, which is the point at which his August hours start
-- converting correctly. A far-past date rather than each person's first
-- shift on purpose: row 507 will import a year of pre-tool history, and a
-- seed anchored to today's earliest shift would leave those imported days
-- with no rate in force at all.
-- =====================================================================

create table if not exists public.crew_member_rates (
  id                  uuid        primary key default gen_random_uuid(),
  crew_member_id      uuid        not null references public.crew_members(id) on delete cascade,
  rate_cents_per_hour integer     not null check (rate_cents_per_hour > 0),
  -- An ET CALENDAR DAY, inclusive. A date and not a timestamp on purpose:
  -- a rate changes on a day, not at an instant, and storing an instant
  -- would invite a timezone question at every read.
  effective_from      date        not null,
  created_at          timestamptz not null default now(),
  -- Who set it. Same nullable-text stamp style as shift_settlements.paid_by.
  created_by          text,
  -- One rate per person per day. Two rows on the same day would make "the
  -- rate in force" ambiguous with no way to break the tie.
  unique (crew_member_id, effective_from)
);

-- The resolver's only query shape: newest effective_from at or before a
-- given day, for one person.
create index if not exists crew_member_rates_person_day_idx
  on public.crew_member_rates (crew_member_id, effective_from desc);

-- RLS ENABLED, ZERO POLICIES -- service-role only, fails closed, the same
-- stance `shifts` and `shift_settlements` take. Written out explicitly even
-- though the platform turned it on by itself when the table was created:
-- a database rebuilt from this file has to end up in the same state as
-- production, and relying on a default nobody wrote down is how that drifts.
-- Idempotent, so re-running changes nothing.
alter table public.crew_member_rates enable row level security;

-- ---------------------------------------------------------------------
-- Seed: one row per person at their current rate, effective far enough
-- back to cover every shift that exists or will be imported.
--
-- Guarded by `not exists` over the PERSON, not over the exact row, so a
-- re-run after somebody has entered real history does not quietly add a
-- second 2000-01-01 row at today's rate underneath their real one.
--
-- Anybody with no positive rate is skipped rather than seeded at zero: a
-- zero-rate row would satisfy the resolver and turn "this person has no
-- rate set, refuse the payment" into a division by nothing.
-- ---------------------------------------------------------------------
insert into public.crew_member_rates (crew_member_id, rate_cents_per_hour, effective_from, created_by)
select c.id, c.base_rate_cents, date '2000-01-01', 'backfill 2026-09-04 (row 506)'
  from public.crew_members c
 where c.base_rate_cents > 0
   and not exists (
     select 1 from public.crew_member_rates r where r.crew_member_id = c.id
   );
