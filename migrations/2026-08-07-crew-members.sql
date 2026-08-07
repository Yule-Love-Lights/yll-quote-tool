-- =====================================================================
-- crew_members — the P4P / Operations Hub identity + pay-config cache
-- (Phase 1 foundation). Quote Tool stays the system of record for pay math,
-- canonical time, and the shared contract with the employee-facing Operations
-- Hub, so this table is the Quote-Tool-side person entity both apps converge
-- on.
--
-- One row per crew member. `hub_employee_id` stays nullable until the Hub's
-- OTP auth ships and backfills its own canonical employee id; until then the
-- interim identity rule allows admin-seeded rows and Telegram-linked flow-B
-- actions keyed by `crew_members.id` / `telegram_user_id`.
--
-- The initial four rows are seeded here from the confirmed P4P base rates.
-- `telegram_user_id` comes from an EXACT normalized display-name join to
-- `bot_users`; if no exact match exists, it stays null. The seed is first-write
-- only by display name so a re-run never overwrites later pay/config edits.
--
-- IMPORTANT — "idempotent / safe to re-run" means SAFE, not a correction
-- mechanism: the WHERE NOT EXISTS guard keys on display_name only, so if a
-- seeded value here turns out wrong (a typo'd rate, say), editing this file
-- and re-running it is a silent no-op — the name already exists, the row is
-- skipped, nothing errors, nothing logs. Fix an already-seeded value with a
-- direct UPDATE (or the crewMembers.ts accessor), never by editing this file.
--
-- RLS ENABLED, ZERO POLICIES — service-role only (shared labor/pay engine
-- server-side). Matches the bot_users / job_material_actuals pattern.
--
-- HOW TO APPLY: applied directly via Supabase MCP (see AGENTS.md's migration-
-- application default) rather than the manual SQL-editor paste this repo used
-- before 2026-08-07. Still idempotent/safe to re-run in the "won't duplicate
-- existing rows" sense above.
-- =====================================================================

create table if not exists public.crew_members (
  id               uuid primary key default gen_random_uuid(),
  hub_employee_id  uuid,
  telegram_user_id text,
  display_name     text not null,
  base_rate_cents  integer not null,
  in_p4p_pool      boolean not null default false,
  pay_mode         text not null default 'hourly' check (pay_mode in ('hourly', 'shadow', 'p4p')),
  language         text not null default 'en',
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists crew_members_hub_employee_id_key
  on public.crew_members (hub_employee_id) where hub_employee_id is not null;

create unique index if not exists crew_members_telegram_user_id_key
  on public.crew_members (telegram_user_id) where telegram_user_id is not null;

alter table public.crew_members enable row level security;

create or replace function public.crew_members_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists crew_members_updated_at on public.crew_members;
create trigger crew_members_updated_at
  before update on public.crew_members
  for each row execute function public.crew_members_set_updated_at();

insert into public.crew_members (
  telegram_user_id,
  display_name,
  base_rate_cents,
  in_p4p_pool,
  pay_mode,
  language,
  active
)
select
  bot.telegram_user_id,
  seed.display_name,
  seed.base_rate_cents,
  seed.in_p4p_pool,
  seed.pay_mode,
  'en',
  true
from (
  values
    ('SonSon', 1600, true, 'shadow'),
    ('Little James', 1700, true, 'shadow'),
    ('Big James', 2000, true, 'shadow'),
    ('Jason Balroop', 1000, false, 'hourly')
) as seed(display_name, base_rate_cents, in_p4p_pool, pay_mode)
left join public.bot_users bot
  on lower(trim(bot.display_name)) = lower(trim(seed.display_name))
where not exists (
  select 1
  from public.crew_members existing
  where lower(trim(existing.display_name)) = lower(trim(seed.display_name))
);
