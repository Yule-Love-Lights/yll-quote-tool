-- =====================================================================
-- The GPS visit timeline, POLLING SHAPE (ledger row 403; supersedes the
-- geofence design). NALDO'S CALL, 2026-08-27: customer coordinates stay inside
-- the quote tool. Nothing about a customer is sent to Bouncie.
--
-- ⚠️ SUPERSEDES TWO UNAPPLIED MIGRATIONS. Do NOT apply
--   2026-08-27-vehicle-visits.sql        (job_geozones + the geofence shape)
--   2026-08-27-job-geozones-vehicle.sql  (its per-vehicle amendment)
-- Neither ever reached the database (verified 2026-08-27: only the phase-2
-- tables exist in prod). They described a design where Bouncie ran server-side
-- geofences around customer homes, which meant sending rooftop coordinates of
-- private houses to a third-party vendor. Naldo asked the obvious question —
-- why does Bouncie need our customers' coordinates at all? — and the honest
-- answer was that it did not. The quote tool polls the vehicle position and
-- compares it against coordinates that never leave our database.
--
-- WHAT THE POLLING DESIGN CHANGES STRUCTURALLY:
--   • No job_geozones table. The SCHEDULE is the watch list (Naldo: "the
--     scheduler is the source of truth"), read at poll time. Nothing to arm,
--     retire, leak, or reconcile with a vendor.
--   • No event provenance columns. Visits derive from REST poll positions, not
--     webhook events, so there is no vehicle_events row to point at. What a
--     visit stores instead is the position evidence itself.
--   • Dwell threshold. Naldo, 2026-08-27: 15 minutes counts as a real visit.
--     Shorter stays are RECORDED but flagged below-threshold, so nothing is
--     thrown away and the number stays tunable by reading, not by re-collecting.
--
-- THE SECOND CLOCK, UNCHANGED. The crew clock in and out by hand and that stays
-- the payroll record; this is the independent record the office compares it
-- against. Row 403 constraint (a) still holds structurally: NO foreign key from
-- here into `shifts` or `job_segments`.
--
-- HOW TO APPLY. One `create table if not exists`, indexes on an empty table,
-- RLS-enable on a brand-new table, and three nullable ADD COLUMNs on
-- `vehicles` (live table, nullable adds are on the AGENTS.md allowlist).
-- No triggers. Apply AFTER the phase-2 migration (2026-08-26).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Last known position per vehicle — what the office map reads.
--
-- Written by the poller on every cycle. `last_seen_at` is Bouncie's own
-- `stats.lastUpdated`, not our poll time, so a stale device shows as stale
-- rather than as freshly parked (row 403 constraint (c): an absent or silent
-- device must read as "no signal", never as "not at the job").
-- ---------------------------------------------------------------------
alter table public.vehicles add column if not exists last_lat double precision;
alter table public.vehicles add column if not exists last_lng double precision;
alter table public.vehicles add column if not exists last_seen_at timestamptz;

-- ---------------------------------------------------------------------
-- vehicle_visits — one row per arrival, derived by proximity.
-- ---------------------------------------------------------------------
create table if not exists public.vehicle_visits (
  id              uuid primary key default gen_random_uuid(),
  vehicle_id      uuid not null references public.vehicles(id) on delete cascade,

  -- What the vehicle was near. 'depot' is the 6 Birch Road day-start anchor and
  -- carries no job; a CHECK keeps the shapes honest so a half-populated row can
  -- never be resolved wrongly.
  kind            text not null check (kind in ('job', 'depot')),
  job_id          uuid references public.jobs(id) on delete set null,
  constraint vehicle_visits_shape check (
    (kind = 'depot' and job_id is null) or (kind = 'job')
  ),

  entered_at      timestamptz not null,
  exited_at       timestamptz,

  -- Naldo's 15-minute rule, applied at CLOSE time and stored rather than
  -- filtered: a below-threshold visit is data about drive-bys and quick stops,
  -- and deleting it would make the radius impossible to tune later.
  below_min_dwell boolean,

  -- The evidence: where the vehicle actually was at entry, straight from the
  -- poll. Replaces webhook-event provenance, and doubles as the record for
  -- tuning the radius (how far from the anchor do real arrivals sit?).
  entered_lat     double precision,
  entered_lng     double precision,

  created_at      timestamptz not null default now()
);

-- "What is open for this vehicle" — the poller's per-cycle lookup. One open
-- visit per vehicle AT MOST, enforced: the poller closes before it opens, and
-- this index makes a bug in that ordering loud instead of silent.
create unique index if not exists vehicle_visits_one_open_per_vehicle
  on public.vehicle_visits (vehicle_id) where exited_at is null;

-- "Every visit to this job, in order" — doubling back shows as two rows.
create index if not exists vehicle_visits_job_idx
  on public.vehicle_visits (job_id, entered_at) where job_id is not null;

-- "What happened that day" — the compare view's read.
create index if not exists vehicle_visits_entered_idx
  on public.vehicle_visits (entered_at desc);

alter table public.vehicle_visits enable row level security;
