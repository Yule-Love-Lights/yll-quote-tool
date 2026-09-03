-- =====================================================================
-- Payments buy HOURS, oldest first, and the remainder rolls over.
-- Jason's rule, 2026-09-03, after the first real settlement.
--
-- WHAT HAPPENED. $180.00 was paid to Khaye for the five weekdays 24-28 Aug.
-- Those shifts come to 20h 34m; at her $9.00/h the money is worth exactly
-- 20h. Phase 3 marked all five shifts paid in full, so the odd 34 minutes
-- were written off by a payment that never covered them. Jason: "instead of
-- the 0.57 get deleted or marked as paid it rolls over... when I put an
-- amount of money in, I want it to automatically mark off the corresponding
-- amount of hours... the first record to be marked approved will be the one
-- from last week, the oldest record."
--
-- WHAT THAT COSTS, STATED PLAINLY. A payment can now land in the MIDDLE of a
-- shift, so a shift can be part paid by one settlement and finished by the
-- next. Phase 3's headline guarantee was a UNIQUE INDEX on (shift_id) where
-- not voided -- "a shift is paid at most once", held by the database rather
-- than by application code. Partial payment cannot be expressed under that
-- index, so it is replaced here by the weaker but correct invariant:
--
--     the live lines against a shift may not sum past that shift's hours.
--
-- That cannot be an index, so it is a trigger. The trigger is deliberately
-- pure arithmetic over this one table -- it never recomputes a shift's hours
-- from clock times and breaks, because that maths lives in TypeScript
-- (paidSecondsForShift) and a second copy of it in SQL would be free to
-- drift. Instead each line CARRIES the shift's total, and the trigger
-- compares numbers already written.
--
-- WHY CARRYING THE TOTAL IS SAFE. A shift with any live payment against it
-- is refused for edit and for removal (ledger row 459, guarded in shifts.ts
-- at the state change). So from the first payment onward a shift's hours are
-- frozen, and the total stamped on the first line stays true for every later
-- line. The trigger asserts the lines agree with each other, so a drift
-- would fail loudly rather than silently mis-cap the sum.
--
-- ALSO HERE: `wise` and `moneygram` join the payment methods. They are how
-- this company actually pays its office staff -- Wise for Khaye and Ann,
-- MoneyGram for Jason -- and until now both were recorded as `other`, which
-- makes "how much went out by Wise" unanswerable. Advertising settlements
-- keep their own four-value list on purpose: different population, and the
-- two lists have no reason to move together.
--
-- HOW TO APPLY. **NOT** on the AGENTS.md safe/additive allowlist and NOT
-- applied automatically: it alters a CHECK constraint on a populated table,
-- drops a unique index, and adds a NOT NULL column to a table with a live
-- row. Every one of those is on the ask-first list. Jason's explicit go is
-- required before this runs against prod.
--
-- It is written to be re-runnable and to leave the existing row correct:
-- the one live settlement (Khaye, $180.00, five lines) is backfilled with
-- each line's paid_seconds as its shift total, which is exactly what those
-- lines mean today -- whole shifts, paid in full.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. The two payment methods this company actually uses.
-- ---------------------------------------------------------------------
alter table public.shift_settlements
  drop constraint if exists shift_settlements_method_check;

alter table public.shift_settlements
  add constraint shift_settlements_method_check
  check (method in ('cash', 'venmo', 'check', 'wise', 'moneygram', 'other'));

-- ---------------------------------------------------------------------
-- 2. Each line carries the whole shift, so a part payment is legible on
--    its own: "3h 48m of a 4h 22m shift".
-- ---------------------------------------------------------------------
alter table public.shift_settlement_lines
  add column if not exists shift_total_seconds integer;

-- Every line written before today covers a WHOLE shift -- that was the only
-- thing the old unique index allowed -- so its paid_seconds IS the total.
update public.shift_settlement_lines
   set shift_total_seconds = paid_seconds
 where shift_total_seconds is null;

alter table public.shift_settlement_lines
  alter column shift_total_seconds set not null;

alter table public.shift_settlement_lines
  drop constraint if exists shift_settlement_lines_total_check;

alter table public.shift_settlement_lines
  add constraint shift_settlement_lines_total_check
  check (shift_total_seconds >= paid_seconds and paid_seconds > 0);

-- ---------------------------------------------------------------------
-- 3. The unique index goes, and a plain one takes its place so the
--    trigger's per-shift sum stays an index lookup.
-- ---------------------------------------------------------------------
drop index if exists public.shift_settlement_lines_shift_key;

create index if not exists shift_settlement_lines_shift_live_idx
  on public.shift_settlement_lines (shift_id) where voided_at is null;

-- ---------------------------------------------------------------------
-- 4. The replacement guarantee.
--
--    Locks the SHIFT row first, so two admins recording payments for the
--    same person at the same moment serialise here instead of both reading
--    a sum that is about to change. Without that lock each transaction
--    would see the other's rows as absent and both would pass.
-- ---------------------------------------------------------------------
create or replace function public.assert_shift_not_overpaid()
returns trigger
language plpgsql
as $$
declare
  live_total   integer;
  shift_total  integer;
  distinct_totals integer;
begin
  -- Voiding a line only ever REDUCES the live sum, so it needs no check and
  -- must not take a lock it does not need.
  if tg_op = 'UPDATE' and new.voided_at is not null then
    return new;
  end if;

  perform 1 from public.shifts where id = new.shift_id for update;

  select coalesce(sum(paid_seconds), 0),
         max(shift_total_seconds),
         count(distinct shift_total_seconds)
    into live_total, shift_total, distinct_totals
    from public.shift_settlement_lines
   where shift_id = new.shift_id and voided_at is null;

  -- Every live line for one shift must agree on how long that shift is. A
  -- disagreement means a shift was edited under a live payment, which the
  -- application refuses -- so if it is ever seen here, stop rather than pick
  -- one of the two answers.
  if distinct_totals > 1 then
    raise exception
      'shift % has live settlement lines disagreeing on its length (% distinct totals)',
      new.shift_id, distinct_totals
      using errcode = 'check_violation';
  end if;

  if live_total > shift_total then
    raise exception
      'shift % would be paid % seconds of its % (over by %)',
      new.shift_id, live_total, shift_total, live_total - shift_total
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists shift_settlement_lines_not_overpaid on public.shift_settlement_lines;

create trigger shift_settlement_lines_not_overpaid
  after insert or update of paid_seconds, voided_at, shift_total_seconds
  on public.shift_settlement_lines
  for each row
  execute function public.assert_shift_not_overpaid();
