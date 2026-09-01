-- =====================================================================
-- Void a settlement (ledger row 492, Naldo's ruling 2026-08-31).
--
-- A payment recorded by mistake had no way back: the unique index meant
-- those photos could never be paid again, and row 481's own rule meant they
-- could never be voided either, so the only recourse was direct database
-- access. Naldo chose an OVERLAY rather than a delete, so the record of what
-- was recorded survives: the row stays, showing who recorded the payment and
-- who undid it, and stops counting as paid.
--
-- This is the same posture as voiding a placement, and the same shape master
-- shipped a day earlier for the bulk-upload dedupe index: a unique index
-- narrowed to LIVE rows so a voided one can be redone.
--
-- The mirrored column on the LINES is what makes the index work. A partial
-- index cannot reference another table, so `voided_at` is stamped onto both
-- the settlement and its lines in one write, and the index keys on the line.
-- The settlement's own copy is what carries the reason and the actor.
--
-- Consequences, all deliberate:
--   * a voided settlement's photos become payable again, because the unique
--     index no longer sees their lines
--   * settled money is summed from LIVE lines, so voiding restores the
--     worker's unpaid figure to what it was before the payment
--   * a photo whose payment was voided can be voided itself again, since
--     nothing live claims it any more
--   * there is no un-void; a payment voided in error is simply recorded again
--
-- HOW TO APPLY: this is ASK-FIRST, not on the safe/additive allowlist. The
-- column adds are additive, but dropping and recreating an existing unique
-- index is a constraint change. It is safe HERE because both tables are
-- empty in production (0 settlements, 0 lines, verified before applying),
-- so the narrower predicate cannot collide with any existing row. Verify
-- that count is still zero before running this.
-- =====================================================================

alter table public.advertising_settlements
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references auth.users(id) on delete set null,
  add column if not exists void_reason text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'advertising_settlements_void_pair'
  ) then
    alter table public.advertising_settlements
      add constraint advertising_settlements_void_pair
      check ((voided_by is null) = (voided_at is null));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'advertising_settlements_void_has_reason'
  ) then
    alter table public.advertising_settlements
      add constraint advertising_settlements_void_has_reason
      check (voided_at is null or void_reason is not null);
  end if;
end $$;

-- The line's own copy of the void stamp. Written in the same statement as
-- the settlement's, and read by the index below.
alter table public.advertising_settlement_lines
  add column if not exists voided_at timestamptz;

-- A LIVE photo is payable at most once. A voided payment releases its
-- photos, which is the whole point of the row-492 ruling.
drop index if exists advertising_settlement_lines_placement_key;

create unique index if not exists advertising_settlement_lines_placement_key
  on public.advertising_settlement_lines (placement_id)
  where voided_at is null;

create index if not exists advertising_settlements_voided_idx
  on public.advertising_settlements (voided_at);
