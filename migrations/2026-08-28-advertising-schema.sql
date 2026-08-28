-- =====================================================================
-- Advertising: workers, campaigns, placements, activity + the private
-- advertising-proof bucket (ops_hub_audit_2026-08.md workstream B slice 1;
-- role lockout #1043 already merged). SCHEMA + DATA LAYER ONLY: no UI, no
-- routes, no account-creation door ships with this.
--
-- NALDO'S RULINGS (2026-08-27, audit doc section 13 — do not reopen):
--   * Advertising workers are their OWN population. Their identity rows live
--     here, never in crew_members; they share only the Supabase auth store
--     (nullable auth_user_id, same shape as crew_members.auth_user_id).
--     Accounts carry app_metadata.role = 'advertising' and are rejected by
--     getOperator / requireOperator / requireAdmin and the role-aware proxy.
--   * Placements stand alone geographically: own lat/lng/accuracy and a
--     reverse-geocoded suggested address. property_id is an OPTIONAL link
--     used only when the location is a customer's house — signs at
--     intersections are normal, so most rows will have it NULL.
--   * Pay is $2.50 per ACCEPTED yard sign, integer cents. The rate is
--     STAMPED onto the placement at acceptance (accepted_rate_cents); a
--     campaign rate change never moves history. Pending and rejected
--     placements never count for pay. A rejected placement can be
--     resubmitted; resubmitted-then-accepted pays exactly once (the stamp
--     happens only on the transition into 'accepted').
--   * Door hangers are modeled (kind = 'door_hanger') but pay for them is
--     PERMANENTLY EXCLUDED until Naldo approves a rule — enforced below by
--     the CHECK that a door hanger's accepted_rate_cents is always NULL.
--
-- STATE-SHAPE CHECKS follow the job_segments / vehicle_visits precedent:
-- a status is only storable with the fields that make it true (a rejected
-- row must say why; an accepted row must have proof and a review time; an
-- accepted yard sign must carry its stamped rate).
--
-- RLS ENABLED, ZERO POLICIES on all four tables — service-role only, the
-- repo default (crew_members / shifts / job_segments pattern). Fails closed
-- until the advertising routes and their policies ship in a later slice.
--
-- HOW TO APPLY: safe/additive per AGENTS.md's migration-application default
-- (brand-new tables, indexes on empty tables, RLS-enable-zero-policies on
-- brand-new tables only, bucket insert guarded by on conflict do nothing).
-- =====================================================================

-- ---------------------------------------------------------------------
-- advertising_workers — the sign-crew identity + login link.
-- One row per person who places signs. display_name is unique on
-- lower(trim()) (crew_members_display_name_key convention) so "Joe" and
-- " joe " cannot become two payees. auth_user_id is the link into the
-- SHARED auth store: nullable (a worker row can exist before their login),
-- unique (one login must never back two payees — that would let one person
-- accrue another's sign money).
-- ---------------------------------------------------------------------
create table if not exists public.advertising_workers (
  id            uuid primary key default gen_random_uuid(),
  display_name  text not null,
  auth_user_id  uuid,
  active        boolean not null default true,
  is_test       boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists advertising_workers_display_name_key
  on public.advertising_workers (lower(trim(display_name)));

create unique index if not exists advertising_workers_auth_user_id_key
  on public.advertising_workers (auth_user_id) where auth_user_id is not null;

alter table public.advertising_workers enable row level security;

-- ---------------------------------------------------------------------
-- advertising_campaigns — a batch of signs/hangers with its per-sign rate.
-- rate_cents is the CURRENT per-accepted-yard-sign rate in integer cents
-- (default 250 = $2.50, Naldo's ruling). It is read at acceptance time and
-- stamped onto the placement; it is never joined into pay history. Runs /
-- sub-batches can come later (audit doc section 10) — kept minimal here.
-- ---------------------------------------------------------------------
create table if not exists public.advertising_campaigns (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  notes       text,
  rate_cents  integer not null default 250 check (rate_cents >= 0),
  active      boolean not null default true,
  is_test     boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.advertising_campaigns enable row level security;

-- ---------------------------------------------------------------------
-- advertising_placements — one row per sign (or door hanger) placed.
--
-- Status machine: pending → accepted | rejected; rejected → resubmitted
-- (worker asks for another look); resubmitted → accepted | rejected.
-- Review fields (reviewed_by/reviewed_at) are stamped by accept AND reject;
-- rejection_reason survives a resubmit so the worker can still see why the
-- last review said no.
--
-- photo_path is a STORAGE PATH into the private advertising-proof bucket,
-- never bytes (the bucket-first rule every storage-backed feature here
-- follows). reviewed_by → auth.users on delete set null, matching
-- invoices.settled_by.
--
-- property_id → properties on delete set null: deleting a property (test
-- sweeps) must not delete placement/pay history, only unlink it.
-- Workers/campaigns are plain FKs (no cascade): a worker or campaign with
-- placement history cannot be deleted out from under the pay record —
-- Postgres itself refuses (23503), the crewMembers StaffHasRecordsError
-- pattern.
-- ---------------------------------------------------------------------
create table if not exists public.advertising_placements (
  id                   uuid primary key default gen_random_uuid(),
  campaign_id          uuid not null references public.advertising_campaigns(id),
  worker_id            uuid not null references public.advertising_workers(id),

  kind                 text not null check (kind in ('yard_sign', 'door_hanger')),
  status               text not null default 'pending'
                         check (status in ('pending', 'accepted', 'rejected', 'resubmitted')),

  lat                  double precision check (lat is null or (lat >= -90 and lat <= 90)),
  lng                  double precision check (lng is null or (lng >= -180 and lng <= 180)),
  accuracy_m           double precision check (accuracy_m is null or accuracy_m >= 0),
  captured_at          timestamptz,

  photo_path           text,
  suggested_address    text,
  route                text,
  neighborhood         text,
  property_id          uuid references public.properties(id) on delete set null,

  rejection_reason     text,
  accepted_rate_cents  integer check (accepted_rate_cents is null or accepted_rate_cents >= 0),
  reviewed_by          uuid references auth.users(id) on delete set null,
  reviewed_at          timestamptz,

  is_test              boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- A rejected placement must say WHY — the worker view shows the reason,
  -- and a reasonless rejection is indistinguishable from a lost write.
  constraint advertising_placements_rejected_has_reason
    check (status <> 'rejected' or rejection_reason is not null),

  -- An accepted placement is a PAY event: it must carry its proof photo and
  -- the review timestamp that anchors day/week earnings.
  constraint advertising_placements_accepted_shape
    check (status <> 'accepted' or (photo_path is not null and reviewed_at is not null)),

  -- An accepted YARD SIGN must carry the stamped rate — pay history lives on
  -- the row, never in a join against the campaign's current rate.
  constraint advertising_placements_accepted_yard_sign_has_rate
    check (status <> 'accepted' or kind <> 'yard_sign' or accepted_rate_cents is not null),

  -- Door hangers NEVER carry a rate (pay permanently excluded until Naldo
  -- approves a rule; do not invent one).
  constraint advertising_placements_door_hanger_never_pays
    check (kind <> 'door_hanger' or accepted_rate_cents is null),

  -- The stamp exists ONLY on an accepted yard sign. This is what makes
  -- "pending and rejected never count for pay" a DB fact rather than a
  -- query convention: no other state can even hold a rate.
  constraint advertising_placements_rate_only_when_accepted
    check (accepted_rate_cents is null or (status = 'accepted' and kind = 'yard_sign')),

  -- Review identity and review time travel together (job_segments
  -- approval-shape convention): "reviewed by nobody at some time" and
  -- "reviewed by someone at no time" are both unstorable.
  constraint advertising_placements_review_pair
    check ((reviewed_by is null) = (reviewed_at is null))
);

create index if not exists advertising_placements_worker_id_idx
  on public.advertising_placements (worker_id);

create index if not exists advertising_placements_campaign_id_idx
  on public.advertising_placements (campaign_id);

-- The admin review queue reads pending/resubmitted newest-first.
create index if not exists advertising_placements_status_created_idx
  on public.advertising_placements (status, created_at desc);

create index if not exists advertising_placements_property_id_idx
  on public.advertising_placements (property_id) where property_id is not null;

alter table public.advertising_placements enable row level security;

-- ---------------------------------------------------------------------
-- advertising_activity — append-only audit trail, mirroring
-- dashboard_activity's shape (actor text / action / detail jsonb /
-- created_at, FKs on delete set null so deleting a subject never deletes
-- its audit rows). Append-only is a DATA-LAYER contract: the module exposes
-- insert and select only, same as dashboard_activity. No updated_at — rows
-- are never updated.
-- ---------------------------------------------------------------------
create table if not exists public.advertising_activity (
  id            uuid primary key default gen_random_uuid(),
  actor         text,                                 -- auth.users id (as text) or 'system'
  action        text not null,                        -- submitted|accepted|rejected|resubmitted|worker_created|campaign_created|rate_changed|...
  placement_id  uuid references public.advertising_placements(id) on delete set null,
  worker_id     uuid references public.advertising_workers(id) on delete set null,
  detail        jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists advertising_activity_placement_idx
  on public.advertising_activity (placement_id);

create index if not exists advertising_activity_created_at_idx
  on public.advertising_activity (created_at desc);

alter table public.advertising_activity enable row level security;

-- ---------------------------------------------------------------------
-- updated_at triggers — one shared function for the three mutable tables
-- (installments uses the shared dashboard_set_updated_at the same way).
-- ---------------------------------------------------------------------
create or replace function public.advertising_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists advertising_workers_updated_at on public.advertising_workers;
create trigger advertising_workers_updated_at
  before update on public.advertising_workers
  for each row execute function public.advertising_set_updated_at();

drop trigger if exists advertising_campaigns_updated_at on public.advertising_campaigns;
create trigger advertising_campaigns_updated_at
  before update on public.advertising_campaigns
  for each row execute function public.advertising_set_updated_at();

drop trigger if exists advertising_placements_updated_at on public.advertising_placements;
create trigger advertising_placements_updated_at
  before update on public.advertising_placements
  for each row execute function public.advertising_set_updated_at();

-- ---------------------------------------------------------------------
-- Private bucket for placement proof photos. Mirrors designs /
-- training-archive / applications: private, service-role only, read back
-- through signed URLs; the row stores only photo_path, never bytes.
-- public = false is asserted here rather than left to a dashboard checkbox.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('advertising-proof', 'advertising-proof', false)
on conflict (id) do nothing;
