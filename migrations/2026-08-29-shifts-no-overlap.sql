-- The database itself refuses overlapping shifts for one person (Naldo's
-- explicit go, 2026-08-29: "Yes constraint"). Closes the check-then-act
-- window in the app-level overlap check on the manual shift editor (PR
-- #1062): two same-instant saves can both pass an application check, but the
-- second one cannot get past this.
--
-- HOW TO APPLY: ASK-FIRST category (a constraint on a live table) — applied
-- 2026-08-29 with Naldo's named consent, after measuring ZERO overlapping
-- pairs in prod (the constraint cannot be created over existing violations).
--
-- An open shift (clock_out_at null) occupies all time from its clock-in
-- onward, matching the app rule. Violations surface as error code 23P01,
-- which adminCreateShift/adminUpdateShiftTimes map to the same 'overlap'
-- refusal the app check produces.

create extension if not exists btree_gist;

alter table public.shifts add constraint shifts_no_overlap
  exclude using gist (
    crew_member_id with =,
    tstzrange(clock_in_at, coalesce(clock_out_at, 'infinity'::timestamptz), '[)') with &&
  );
