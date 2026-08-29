-- =====================================================================
-- Pay per accepted PHOTO (Naldo's 2026-08-29 ruling, superseding the
-- 2026-08-27 door-hangers-never-pay exclusion): a campaign's rate_cents is
-- paid for EVERY accepted placement, whatever its kind. The campaign's NAME
-- says whether it is a yard-sign or door-hanger campaign; the kind on each
-- placement records which it was, and the worker still picks it at capture.
--
-- What changes at the DB:
--   * DROP advertising_placements_door_hanger_never_pays (the superseded
--     exclusion) and the two rate-shape checks that special-cased yard
--     signs.
--   * BACKFILL: any already-ACCEPTED placement with a NULL rate gets its
--     campaign's CURRENT rate stamped (at apply time this is exactly one
--     is_test door hanger from the E2E fixtures; the UPDATE is written
--     generically and is idempotent — it matches only NULL rates).
--   * ADD the generalized pair: an accepted placement must carry its
--     stamped rate; a rate can exist ONLY on an accepted placement.
--
-- HOW TO APPLY: this is a CHECK-constraint change on a populated table, so
-- it is OUTSIDE the safe/additive allowlist and needs the dev's named
-- go — given by Naldo 2026-08-29 ("rate per photo... I would make an
-- adjustment to that"). Idempotent: drops are IF EXISTS, adds are guarded
-- by name checks, the backfill matches only NULL rates.
-- =====================================================================

alter table public.advertising_placements
  drop constraint if exists advertising_placements_door_hanger_never_pays;

alter table public.advertising_placements
  drop constraint if exists advertising_placements_accepted_yard_sign_has_rate;

alter table public.advertising_placements
  drop constraint if exists advertising_placements_rate_only_when_accepted;

-- Backfill accepted rows that predate per-photo pay (kind-agnostic on
-- purpose; only NULL rates are touched, so stamped history never moves).
update public.advertising_placements p
set accepted_rate_cents = c.rate_cents
from public.advertising_campaigns c
where p.campaign_id = c.id
  and p.status = 'accepted'
  and p.accepted_rate_cents is null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'advertising_placements_accepted_has_rate'
  ) then
    alter table public.advertising_placements
      add constraint advertising_placements_accepted_has_rate
      check (status <> 'accepted' or accepted_rate_cents is not null);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'advertising_placements_rate_only_when_accepted'
  ) then
    alter table public.advertising_placements
      add constraint advertising_placements_rate_only_when_accepted
      check (accepted_rate_cents is null or status = 'accepted');
  end if;
end $$;
