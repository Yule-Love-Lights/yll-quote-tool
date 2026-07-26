-- =====================================================================
-- bot_users — the text-ops bot's roster, managed from Settings → Bot team
-- (text-ops bot, ledger #168). Moves crew/staff/admin role management OFF the
-- TELEGRAM_ADMIN/STAFF/CREW_USERS env vars (which needed a Vercel redeploy on
-- every roster change) into a DB table an admin edits in the app.
--
-- One row per Telegram USER id (message.from.id), NOT per chat: roles are keyed
-- to the person, so the same user carries their role into any allowlisted room.
-- The room allowlist (which chats the bot answers in at all) stays in
-- TELEGRAM_ALLOWED_CHATS for now.
--
-- The env vars remain a LOCKOUT-PROOF FLOOR: resolveSenderRole takes the higher
-- of the DB role and the env role, so the bootstrap admins can never be demoted
-- out of access by a bad DB edit. A brand-new person is managed entirely here.
--
-- RLS ENABLED, ZERO POLICIES — service-role only (the admin API routes run
-- server-side behind requireAdmin). Matches the website_leads /
-- job_material_actuals pattern.
--
-- HOW TO APPLY: paste into the Supabase SQL Editor and Run. Idempotent.
-- =====================================================================

create table if not exists public.bot_users (
  telegram_user_id text primary key,
  display_name     text,
  role             text not null check (role in ('crew', 'staff', 'admin')),
  -- Who added/last-changed this row (an operator email or 'seed'), for the audit
  -- trail — the same reason bot_audit_log records who did what.
  added_by         text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

alter table public.bot_users enable row level security;

-- Bump updated_at on every change (mirrors the jobs / inventory_on_hand trigger).
create or replace function public.bot_users_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists bot_users_updated_at on public.bot_users;
create trigger bot_users_updated_at
  before update on public.bot_users
  for each row execute function public.bot_users_set_updated_at();
