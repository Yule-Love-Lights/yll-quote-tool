-- =====================================================================
-- Placement VOID (Naldo's 2026-08-29 go, closing the duplicate-overcount
-- deferral from the allotments round): an admin can void a placement so it
-- stops counting ANYWHERE — pay, pending estimates, a worker's sign
-- allotment, warehouse-facing accepted counts, and duplicate flags — while
-- the row itself, its status history, and its stamped rate stay intact as
-- the record of what happened. Void is an OVERLAY (three nullable columns),
-- not a status: nothing in the existing state machine changes shape, and
-- there is still no delete path.
--
-- Rules, enforced here: who and when travel together, and a void always
-- carries its reason (an unexplained reversal of pay is worse than none).
-- Un-voiding does not exist; a wrongly voided sign gets re-submitted.
--
-- HOW TO APPLY: safe/additive per AGENTS.md — three nullable column-adds
-- whose CHECKs are trivially satisfied by every existing row (all NULL).
-- =====================================================================

alter table public.advertising_placements
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references auth.users(id) on delete set null,
  add column if not exists void_reason text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'advertising_placements_void_pair'
  ) then
    alter table public.advertising_placements
      add constraint advertising_placements_void_pair
      check ((voided_by is null) = (voided_at is null));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'advertising_placements_void_has_reason'
  ) then
    alter table public.advertising_placements
      add constraint advertising_placements_void_has_reason
      check (voided_at is null or void_reason is not null);
  end if;
end $$;
