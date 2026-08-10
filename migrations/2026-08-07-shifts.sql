-- =====================================================================
-- shifts - the canonical day-level clock ledger for Operations Hub Flow B.
-- Quote Tool owns canonical time, so hub / Telegram / office capture surfaces
-- submit commands here and the QT becomes the system of record for open/closed
-- day envelopes before later phases add breaks, job segments, and approvals.
--
-- One row per clock-in / clock-out envelope. `crew_member_id` is the acting
-- identity (`crew_members.id`). The DB, not a read-then-check, enforces the
-- idempotency guarantee that one person can have at most one OPEN shift at a
-- time: a partial unique index on crew_member_id where clock_out_at is null.
--
-- RLS ENABLED, ZERO POLICIES - service-role only for now. Matches the
-- crew_members / bot_users pattern and fails closed until the Flow B routes
-- and policies ship.
--
-- HOW TO APPLY: applied directly via Supabase MCP per AGENTS.md's migration-
-- application default. This is safe/additive: a brand-new table + indexes +
-- RLS-with-zero-policies on that brand-new table.
-- =====================================================================

create table if not exists public.shifts (
  id              uuid primary key default gen_random_uuid(),
  crew_member_id  uuid not null references public.crew_members(id),
  clock_in_at     timestamptz not null default now(),
  clock_out_at    timestamptz,
  source          text not null check (source in ('pwa', 'telegram', 'office', 'system')),
  device_time     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists shifts_one_open_per_person
  on public.shifts (crew_member_id) where clock_out_at is null;

create index if not exists shifts_crew_member_id_idx
  on public.shifts (crew_member_id);

alter table public.shifts enable row level security;

create or replace function public.shifts_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists shifts_updated_at on public.shifts;
create trigger shifts_updated_at
  before update on public.shifts
  for each row execute function public.shifts_set_updated_at();
