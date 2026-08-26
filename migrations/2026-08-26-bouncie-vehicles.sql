-- =====================================================================
-- Fleet GPS phase 2 — the Bouncie capture tables (ledger row 403).
--
-- WHY CAPTURE-ONLY. The devices arrive today and nothing has ever seen a
-- real Bouncie payload. Row 403's vendor facts were search-sourced and TWO of
-- them turned out to be wrong when the real OpenAPI spec was finally read
-- (auth is OAuth-only with no API key; tripStart/tripEnd carry no location).
-- The spec can be wrong about reality the same way search was wrong about the
-- spec, so the first thing built is an instrument, not a feature: verify the
-- shared secret, store the event exactly as it arrived, decide nothing.
--
-- The first real event then TELLS us whether the spec matches, instead of us
-- guessing and finding out through a defect. Everything downstream — the map,
-- the geofences, the arrive/depart suggestions — waits for that answer.
--
-- WHAT THIS IS NOT. Nothing here touches payroll, and nothing here can.
-- Row 403 constraint (a) is absolute: GPS never writes payroll. There is no
-- foreign key from these tables into `job_segments`, `shifts` or `jobs`, and
-- no code in this migration's PR writes to any of them. A geofence may only
-- ever SUGGEST an arrive/depart to a crew member's own device, and a human
-- still affirmatively taps.
--
-- HOW TO APPLY. Three `create table if not exists` on brand-new tables, plus
-- indexes on tables with no rows, plus RLS-enable-with-no-policies on new
-- tables only. All four shapes are on AGENTS.md's safe/additive allowlist, so
-- this applies directly without waiting for the PR to merge. It adds nothing
-- to, and alters nothing on, any existing table.
-- =====================================================================

-- ---------------------------------------------------------------------
-- vehicles — one row per tracked vehicle.
--
-- Row 403 constraint (c): the Bouncie subscription and the trip history belong
-- to the DEVICE (the imei), not to the vehicle it happens to be plugged into.
-- Moving the truck's tracker into the van would file the van's miles under the
-- truck. So the imei lives here as the CURRENT device for this vehicle and is
-- unique across the table: one device, one vehicle, never shared.
--
-- `active` exists so a vehicle can be retired without deleting the history that
-- points at it.
-- ---------------------------------------------------------------------
create table if not exists public.vehicles (
  id          uuid primary key default gen_random_uuid(),
  label       text not null,
  imei        text,
  vin         text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One device per vehicle. Partial so several vehicles may sit unprovisioned
-- (imei null) before the hardware is paired.
create unique index if not exists vehicles_imei_key
  on public.vehicles (imei) where imei is not null;

create unique index if not exists vehicles_vin_key
  on public.vehicles (vin) where vin is not null;

-- ---------------------------------------------------------------------
-- vehicle_crew — the STATIC vehicle-to-crew assignment.
--
-- Row 403 constraint (d): the same crew rides the same vehicle daily, so this
-- is a setting somebody edits when a crew actually changes, NOT a daily screen.
-- A vehicle carries a CREW, so this is one row per crew member per vehicle and
-- the map label holds several names, not one.
--
-- KNOWN LIMIT, recorded rather than hidden (S68 staff lens): reality diverges
-- from a static setting on a sick day, a swapped vehicle, or a crew split
-- across two jobs. A wrong name on a map is worse than no name, so whatever
-- reads this later must show the assignment as an assumption ("usually Mike +
-- Dave") and never as an assertion about who is physically in the vehicle.
-- ---------------------------------------------------------------------
create table if not exists public.vehicle_crew (
  id              uuid primary key default gen_random_uuid(),
  vehicle_id      uuid not null references public.vehicles (id) on delete cascade,
  crew_member_id  uuid not null references public.crew_members (id) on delete cascade,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);

create unique index if not exists vehicle_crew_vehicle_member_key
  on public.vehicle_crew (vehicle_id, crew_member_id);

create index if not exists vehicle_crew_vehicle_idx
  on public.vehicle_crew (vehicle_id) where active;

-- ---------------------------------------------------------------------
-- vehicle_events — the raw capture log.
--
-- EVERY COLUMN EXCEPT THE PAYLOAD AND ITS HASH IS NULLABLE, ON PURPOSE. This
-- table's job is to record what Bouncie actually sent, including a payload that
-- does NOT match the published spec — that is the single most valuable thing it
-- can catch. A NOT NULL on `event_type` would drop exactly the event worth
-- seeing. The receiver likewise never rejects a body it cannot parse.
--
-- DEDUPE. Bouncie documents duplicates as normal, not as an edge case: a
-- real-time stream and a periodic stream overlap by design, and a device that
-- loses cell signal buffers its trip and dumps it in a burst on reconnect.
-- Retries add more. `transaction_id` identifies a TRIP, not an event, so many
-- distinct events legitimately share one — it cannot be the dedupe key.
-- The key is a sha256 over the exact request body: a retransmission of the same
-- event is byte-identical and collapses, while two genuinely different events
-- differ somewhere and both survive.
-- ---------------------------------------------------------------------
create table if not exists public.vehicle_events (
  id              uuid primary key default gen_random_uuid(),
  received_at     timestamptz not null default now(),
  event_type      text,
  imei            text,
  vin             text,
  transaction_id  text,
  occurred_at     timestamptz,
  body_sha256     text not null,
  payload         jsonb not null
);

-- Idempotency. An identical redelivery is ignored rather than stored twice.
create unique index if not exists vehicle_events_body_sha256_key
  on public.vehicle_events (body_sha256);

-- "What has this device sent lately" — the staleness question. Bouncie silently
-- auto-deactivates a webhook that keeps failing, so "no events for N hours"
-- is a real alarm condition, not just quiet.
create index if not exists vehicle_events_imei_received_idx
  on public.vehicle_events (imei, received_at desc);

create index if not exists vehicle_events_transaction_idx
  on public.vehicle_events (transaction_id) where transaction_id is not null;

-- ---------------------------------------------------------------------
-- RLS. Service-role model, same as the rest of this schema: enable RLS with no
-- policies so nothing is reachable except through the service role. Safe here
-- because all three tables are brand new and have no live anon reads to break.
-- ---------------------------------------------------------------------
alter table public.vehicles       enable row level security;
alter table public.vehicle_crew   enable row level security;
alter table public.vehicle_events enable row level security;
