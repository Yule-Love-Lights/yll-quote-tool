-- =====================================================================
-- job_segments - per-job time on the shift clock (Operations Hub Flow B,
-- Track A Phase 2 slice 2).
--
-- One row per arrive/depart pair. `shift_id` ties the segment to the day
-- envelope; `crew_member_id` is denormalized from that shift so the write
-- path can authorize without a join, matching shift_breaks.
--
-- WHAT THIS FEEDS, and why it is money code: job seconds divided into the
-- job's budgeted_hours is the efficiency number the P4P pool pays on. Time
-- credited to a job that was not worked on it inflates efficiency and
-- overpays; time lost understates it and underpays.
--
-- BREAKS PAUSE JOB TIME (contract section 4: "Break pauses job time and
-- route collection; break end resumes the day, not the job"). So job
-- seconds are the segment spans MINUS any overlapping break spans. That
-- subtraction lives in src/lib/jobSegments.ts on the shared interval math
-- in src/lib/timeSpans.ts, with its own tests.
--
-- `entry_kind`:
--   install      - the default, ordinary work against the job's budget.
--   rework       - allowed against a CLOSED job. Rolls into that job's
--                  actual hours for efficiency but NEVER reopens billing
--                  (A5 Phase 2). Its own kind so the payout engine can
--                  tell the difference.
--   non_billable - requires approval; `approved_by` records who.
--
-- `stoppage_reason` is set when the segment closes and ships from day one,
-- because it cannot be backfilled - nobody will remember which Tuesday it
-- rained, and a crew sent home 40% through a job otherwise reads as beating
-- the budget and poisons the shadow-mode learning signal. `weather` rows
-- are excluded from the BH learning signal downstream.
--
-- At most one OPEN segment per shift, enforced by the DB with a partial
-- unique index, same shape as shifts_one_open_per_person and
-- shift_breaks_one_open_per_shift. The write path recovers the winner on
-- 23505 so a concurrent double-tap is idempotent rather than an error.
--
-- `auto_closed` marks a segment a clock-out ended rather than the crew
-- member, feeding the `open_segment` time-exception queue. A review state,
-- not an error state.
--
-- RLS ENABLED, ZERO POLICIES - service-role only, matching crew_members /
-- shifts / shift_breaks. Fails closed until the Flow B routes and their
-- policies ship.
--
-- HOW TO APPLY: safe/additive per AGENTS.md's migration-application default
-- (brand-new table, indexes on an empty table, RLS-enable-zero-policies on
-- that new table). APPLIED to prod 2026-08-12 and verified by real queries
-- rather than the tool's success message: 16 columns, 6 indexes, RLS enabled
-- with 0 policies, 7 check constraints, the partial unique index present with
-- its `WHERE (departed_at IS NULL)` predicate, and 0 rows.
-- =====================================================================

create table if not exists public.job_segments (
  id              uuid primary key default gen_random_uuid(),
  shift_id        uuid not null references public.shifts(id),
  crew_member_id  uuid not null references public.crew_members(id),
  job_id          uuid not null references public.jobs(id),

  arrived_at      timestamptz not null default now(),
  departed_at     timestamptz,

  entry_kind      text not null default 'install'
                    check (entry_kind in ('install', 'rework', 'non_billable')),

  -- Null while the segment is open; required by the application on close.
  stoppage_reason text
                    check (stoppage_reason in ('completed', 'weather', 'no_access', 'materials', 'other')),

  source          text not null check (source in ('pwa', 'telegram', 'office', 'system')),
  end_source      text check (end_source in ('pwa', 'telegram', 'office', 'system')),

  auto_closed     boolean not null default false,

  -- Only meaningful for entry_kind = 'non_billable'.
  approved_by     uuid references public.crew_members(id),
  approved_at     timestamptz,

  device_time     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- A segment cannot end before it began. Guards an office-correction typo
  -- from minting negative job time, which would understate efficiency.
  constraint job_segments_ends_after_start
    check (departed_at is null or departed_at >= arrived_at),

  -- A closed segment must say WHY it closed; an open one must not pretend to.
  constraint job_segments_reason_matches_state
    check ((departed_at is null) = (stoppage_reason is null)),

  -- Approval only belongs on a non_billable segment, and both halves travel
  -- together so "approved by nobody at some time" cannot be recorded.
  constraint job_segments_approval_shape
    check (
      (approved_by is null and approved_at is null)
      or (entry_kind = 'non_billable' and approved_by is not null and approved_at is not null)
    )
);

create unique index if not exists job_segments_one_open_per_shift
  on public.job_segments (shift_id) where departed_at is null;

create index if not exists job_segments_shift_id_idx
  on public.job_segments (shift_id);

create index if not exists job_segments_job_id_idx
  on public.job_segments (job_id);

create index if not exists job_segments_crew_member_id_idx
  on public.job_segments (crew_member_id);

-- The missed-tap backstop scans for open segments; keep that scan cheap.
create index if not exists job_segments_open_arrived_at_idx
  on public.job_segments (arrived_at) where departed_at is null;

alter table public.job_segments enable row level security;

create or replace function public.job_segments_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists job_segments_updated_at on public.job_segments;
create trigger job_segments_updated_at
  before update on public.job_segments
  for each row execute function public.job_segments_set_updated_at();
