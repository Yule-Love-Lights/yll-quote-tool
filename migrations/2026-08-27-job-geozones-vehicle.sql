-- =====================================================================
-- ⚠️ SUPERSEDED — DO NOT APPLY. Never reached any database.
--
-- Replaced by 2026-08-28-vehicle-visits-polling.sql on Naldo's 2026-08-27 call:
-- customer coordinates stay inside the quote tool, so there are no Bouncie
-- geofences, no job_geozones table, and no per-vehicle zone bookkeeping. The
-- schedule is the watch list, read at poll time. Kept for history only.
-- =====================================================================

-- =====================================================================
-- job_geozones gets the vehicle it belongs to (ledger row 403, phase 3c).
--
-- WHY. A Bouncie geozone is PER-DEVICE: `POST /v1/application-geozones` takes an
-- imei, so a job site watched by two vans needs two zones over one location.
-- The original table recorded only (job_id, assigned_date), which meant two rows
-- for the same job differed in nothing our schema could see.
--
-- That was not merely untidy. The idempotency check asked "is this job already
-- armed", so a job that armed successfully for the FIRST van and then failed for
-- the second was marked armed forever, and the second van never got its zone.
-- The failure is invisible: arrivals simply never register for that vehicle at
-- that job, which reads as a crew that did not show up. Found by the S68
-- technical lens.
--
-- HOW TO APPLY. One nullable ADD COLUMN plus indexes, on a table that has no
-- rows anywhere yet (its own migration has not been applied either). Safe and
-- additive per AGENTS.md, no trigger, no separate go needed.
-- =====================================================================

-- Nullable because the depot zone is per-vehicle too but existing rows (there
-- are none) would have nothing to backfill from, and because a NOT NULL on a
-- column added later is the kind of thing that fails on a table with data.
alter table public.job_geozones
  add column if not exists vehicle_id uuid references public.vehicles(id) on delete cascade;

create index if not exists job_geozones_vehicle_idx
  on public.job_geozones (vehicle_id) where retired_at is null;

-- The idempotency key is now per VEHICLE, not per job. Replaces the old
-- job+date index, which could not tell "armed for both vans" from "armed for one
-- and failed for the other".
drop index if exists job_geozones_job_date_live_key;

create unique index if not exists job_geozones_job_date_vehicle_live_key
  on public.job_geozones (job_id, assigned_date, vehicle_id)
  where retired_at is null and kind = 'job';
