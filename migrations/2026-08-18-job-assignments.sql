-- =====================================================================
-- job_assignments - which crew member is on which job on which day
-- (P4P Track A Phase 3: scheduling).
--
-- One row per (job, crew member, date). A job worked over three days by two
-- people is six rows, which is what makes per-day capacity answerable at all.
--
-- WHY A DATE COLUMN RATHER THAN LEANING ON jobs.install_date: a job can span
-- days, and `install_date` is a single value. It also has never been written
-- by anything (see the note in src/lib/jobs.ts), so building capacity on it
-- would mean building on a column that is empty in every existing row.
--
-- WHAT THIS FEEDS: capacity. Per the plan, Phase 1 computes job-level budgeted
-- hours only, so per-person capacity for a day is that job's BH divided across
-- the crew assigned to it that day. A job scheduled with nobody assigned reads
-- as UNASSIGNED LOAD rather than silently contributing zero.
--
-- ⚠️ Every budgeted_hours value in prod is still a PLACEHOLDER production rate
-- (jobs.rates_are_placeholder). Capacity computed from it is therefore also
-- placeholder, and the scheduling layer says so rather than presenting invented
-- hours as a real day's load. See src/lib/laborPlan.ts.
--
-- RLS ENABLED, ZERO POLICIES - service-role only, matching every other table in
-- this track. Fails closed until scheduling routes and policies ship.
--
-- HOW TO APPLY: safe/additive per AGENTS.md's migration-application default
-- (brand-new table, indexes on an empty table, RLS-enable-zero-policies on that
-- new table).
--
-- APPLIED to prod 2026-08-20 (S61) and verified by query, not the tool's success
-- message: 7 columns, 5 indexes, RLS enabled with 0 policies, 1 trigger, 0 rows.
-- (It shipped in PR #802 marked NOT YET APPLIED because the Supabase MCP had lost
-- its access token mid-session; applied a few days later once the token was back.)
-- =====================================================================

create table if not exists public.job_assignments (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.jobs(id) on delete cascade,
  crew_member_id  uuid not null references public.crew_members(id),

  -- The calendar day this assignment is for, in the BUSINESS timezone. A DATE,
  -- not a timestamptz: "who is on this job on the 22nd" is a calendar question,
  -- and storing an instant would reintroduce the UTC-vs-ET drift this repo has
  -- already been bitten by.
  assigned_date   date not null,

  -- Who scheduled it, for the same reason every other consequential action here
  -- records a source.
  created_by      uuid references public.crew_members(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- One person cannot be assigned to the same job twice on the same day.
  constraint job_assignments_unique_per_day unique (job_id, crew_member_id, assigned_date)
);

-- ON DELETE CASCADE on job_id: an assignment to a deleted job is meaningless.
-- crew_member_id deliberately has NO cascade — deleting a crew member who has
-- scheduled work should fail loudly rather than silently unschedule the work.

create index if not exists job_assignments_date_idx
  on public.job_assignments (assigned_date);

create index if not exists job_assignments_crew_date_idx
  on public.job_assignments (crew_member_id, assigned_date);

create index if not exists job_assignments_job_id_idx
  on public.job_assignments (job_id);

alter table public.job_assignments enable row level security;

create or replace function public.job_assignments_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists job_assignments_updated_at on public.job_assignments;
create trigger job_assignments_updated_at
  before update on public.job_assignments
  for each row execute function public.job_assignments_set_updated_at();
