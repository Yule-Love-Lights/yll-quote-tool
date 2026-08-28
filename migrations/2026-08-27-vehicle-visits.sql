-- =====================================================================
-- ⚠️ SUPERSEDED — DO NOT APPLY. Never reached any database.
--
-- Replaced by 2026-08-28-vehicle-visits-polling.sql on Naldo's 2026-08-27 call:
-- customer coordinates stay inside the quote tool, so there are no Bouncie
-- geofences, no job_geozones table, and no per-vehicle zone bookkeeping. The
-- schedule is the watch list, read at poll time. Kept for history only.
-- =====================================================================

-- =====================================================================
-- The GPS visit timeline — the SECOND CLOCK (ledger row 403, phase 3b).
--
-- WHAT THIS IS FOR. Naldo, 2026-08-27: *"they'll have two clocks: their main
-- one, which is the one they actually clocked in for, and our double check."*
-- The crew keep clocking in and out by hand exactly as they do today, and that
-- stays the payroll record. This table is an independent second record of the
-- same day, derived from where the vans actually were, so the two can be
-- COMPARED. It answers "how long did that job really take" and "did they double
-- back", which nothing in the system can answer today.
--
-- ROW 403 CONSTRAINT (a), STRUCTURALLY ENFORCED: GPS NEVER WRITES PAYROLL.
-- There is deliberately NO foreign key from here into `shifts` or
-- `job_segments`, and nothing that writes this table touches them. A geofence
-- may only ever SUGGEST; a human still affirmatively taps. Keeping the two
-- clocks in separate tables is what makes a disagreement between them VISIBLE
-- rather than quietly resolved in favour of one.
--
-- WHY VISITS AND NOT ONE ROW PER JOB. A crew doubling back is a real thing Naldo
-- explicitly wants to see, so a second trip to the same address on the same day
-- must appear as a second visit rather than overwriting the first. Hence one row
-- per arrival, not one per job.
--
-- HOW TO APPLY. Two `create table if not exists` on brand-new tables, indexes on
-- empty tables, and RLS-enable-with-no-policies on new tables only. All three
-- shapes sit on AGENTS.md's safe/additive allowlist, so unlike the OAuth
-- migration this one carries no trigger and needs no separate go.
-- =====================================================================

-- ---------------------------------------------------------------------
-- job_geozones — the mapping between OUR jobs and BOUNCIE's geofences.
--
-- Bouncie runs the geofence server-side and tells us ENTER/EXIT by its own zone
-- id. That id means nothing to us on its own, so this is the lookup that turns
-- an incoming event back into "the Smith job on the 28th".
--
-- Zones are armed only for days that actually have scheduled jobs (Naldo's
-- rule), so rows here are created the night before and retired after. `retired_at`
-- rather than deletion, because an event can arrive slightly after we tear a
-- zone down and we would rather resolve it than drop it.
--
-- `job_id` is NULLABLE on purpose: the depot zone (6 Birch Road, Amityville) is
-- not a job. `kind` says which it is, so a reader never has to infer it from a
-- null.
-- ---------------------------------------------------------------------
create table if not exists public.job_geozones (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null check (kind in ('job', 'depot')),
  job_id               uuid references public.jobs(id) on delete cascade,
  assigned_date        date,
  bouncie_location_id  text not null,
  bouncie_geozone_id   text not null,
  created_at           timestamptz not null default now(),
  retired_at           timestamptz,

  -- A depot zone has no job and no date; a job zone must have both. Enforced
  -- here rather than in code, because a half-populated row would resolve events
  -- to the wrong thing silently.
  constraint job_geozones_shape check (
    (kind = 'depot' and job_id is null and assigned_date is null)
    or (kind = 'job' and job_id is not null and assigned_date is not null)
  )
);

-- The lookup the webhook does on every geozone event.
create unique index if not exists job_geozones_bouncie_geozone_key
  on public.job_geozones (bouncie_geozone_id);

-- One live zone per job per day. Partial, so a retired zone does not block
-- re-arming the same job on a later date.
create unique index if not exists job_geozones_job_date_live_key
  on public.job_geozones (job_id, assigned_date) where retired_at is null and kind = 'job';

-- At most one live depot zone.
create unique index if not exists job_geozones_depot_live_key
  on public.job_geozones (kind) where retired_at is null and kind = 'depot';

-- ---------------------------------------------------------------------
-- vehicle_visits — one row per arrival.
--
-- `exited_at` is NULL while a vehicle is still there. That is a normal, expected
-- state during the working day, not an error, and any reader has to handle it.
--
-- WHAT ACTUALLY MAKES THIS IDEMPOTENT is the writer refusing to open a second
-- visit while one is already open for the same vehicle and zone — not the unique
-- index below. Bouncie's documented duplicate pattern is two SEPARATE deliveries
-- reporting one physical arrival (its real-time and periodic streams overlap,
-- and a device that loses signal dumps a burst on reconnect). Those differ in
-- bytes, so a per-event index cannot see them as duplicates at all.
-- ---------------------------------------------------------------------
create table if not exists public.vehicle_visits (
  id              uuid primary key default gen_random_uuid(),
  vehicle_id      uuid not null references public.vehicles(id) on delete cascade,
  geozone_id      uuid not null references public.job_geozones(id) on delete cascade,

  -- Denormalised from job_geozones so the common queries ("visits to this job",
  -- "did they leave the depot today") do not need a join, and so a visit stays
  -- readable if its zone is later retired.
  kind            text not null check (kind in ('job', 'depot')),
  job_id          uuid references public.jobs(id) on delete set null,

  entered_at      timestamptz not null,
  exited_at       timestamptz,

  -- Which raw events produced this. The whole point of the capture table is that
  -- any derived row can be traced back to the bytes Bouncie actually sent.
  --
  -- BOTH ARE `on delete set null`, AND NULLABLE, ON PURPOSE. An earlier draft had
  -- `enter_event_id not null ... on delete cascade`, which meant that the moment
  -- anyone purged old raw events — and this project already anticipates a
  -- retention job — every visit derived from them would be silently deleted too.
  -- The timeline is the durable record; the raw event is the receipt for it.
  -- Losing the receipt should cost the provenance link, not the history.
  -- Found by the S68 technical lens.
  enter_event_id  uuid references public.vehicle_events(id) on delete set null,
  exit_event_id   uuid references public.vehicle_events(id) on delete set null,

  created_at      timestamptz not null default now()
);

-- Provenance uniqueness: one visit per source event. Partial, because the column
-- is nullable now — a purged raw event leaves its visit intact with a null link,
-- and several such rows must not collide with each other.
--
-- NOTE this is NOT what makes arrivals idempotent. It only catches a redelivery
-- of the SAME stored event, and those never reach the visit writer anyway: the
-- body hash on `vehicle_events` drops them first. Real duplicate arrivals come
-- from Bouncie's overlapping streams as DIFFERENT events reporting one physical
-- arrival, and the writer guards those by refusing to open a second visit while
-- one is already open for that vehicle and zone.
create unique index if not exists vehicle_visits_enter_event_key
  on public.vehicle_visits (enter_event_id) where enter_event_id is not null;

-- "What is still open for this vehicle" — the lookup EXIT does.
create index if not exists vehicle_visits_open_idx
  on public.vehicle_visits (vehicle_id, geozone_id) where exited_at is null;

-- "Every visit to this job, in order" — including the second one when a crew
-- doubles back, which is the point.
create index if not exists vehicle_visits_job_idx
  on public.vehicle_visits (job_id, entered_at) where job_id is not null;

-- "What happened on this day" — the comparison view against the manual clock.
create index if not exists vehicle_visits_entered_idx
  on public.vehicle_visits (entered_at desc);

alter table public.job_geozones   enable row level security;
alter table public.vehicle_visits enable row level security;
