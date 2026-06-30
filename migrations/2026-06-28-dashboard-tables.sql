-- DRAFT — apply out-of-band after review; do not run automatically.
--
-- Unified Customer Dashboard (#58) — the 6 net-new tables behind the /inbox tab.
-- Every inbound customer touch (GHL / Gmail / Quote Tool / Homeworks) becomes one
-- inbox_items row, de-duped to one dashboard_contacts card; follow_ups + the
-- escalation engine are the anti-fall-through safety net; dashboard_activity is
-- the audit trail; integration_tokens + sync_cursors are server-only plumbing.
--
-- ⚠️ DELIBERATE DIVERGENCE FROM THE HOUSE CONVENTION. The existing PII tables
-- (quotes/customers/designs/…) ship with RLS DISABLED and are reached only via
-- the service-role client. These NEW tables ship with RLS ENABLED + explicit
-- policies from day one (the dashboard's whole premise is locking PII down —
-- closing the prior incident). Authenticated operators get SELECT/UPDATE on the
-- three operator tables; all INSERTs and all token/cursor access go through the
-- service-role client (which bypasses RLS). integration_tokens + sync_cursors are
-- deny-all to authenticated.
--
-- DESIGN NOTE — SHARED QUEUE (confirmed with Naldo 2026-06-28). An office/sales
-- team answers customers, and new messages land in ONE shared "open" list that
-- anyone grabs. So `assigned_to` is NULLABLE and UNCLAIMED IS THE NORMAL STATE —
-- this intentionally reverses the original plan's "auto-assign to Naldo /
-- unassigned-not-allowed." Escalation is team-wide (not per-assignee), so no
-- assignment is required for an item to escalate.
--
-- IDEMPOTENT + ROLL-FORWARD: safe to re-run (create … if not exists; policies are
-- dropped-then-created). To change a table later, add a NEW migration — do not
-- edit this file after it has been applied.
--
-- HOW TO APPLY (when a human approves): paste into Supabase → SQL Editor → Run.
-- There is no automated migration runner on this project.

begin;

-- citext gives case-insensitive email matching at the DB layer (belt-and-suspenders
-- with the app-side normalize.ts lowercasing). Allowed extension on Supabase.
create extension if not exists citext;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. dashboard_contacts — one card per human, collapsed across channels.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.dashboard_contacts (
  id                uuid primary key default gen_random_uuid(),
  display_name      text,
  primary_email     citext,
  primary_phone     text,                              -- E.164, e.g. +16315551234
  emails            citext[] not null default '{}',    -- all known emails (append on match)
  phones            text[]   not null default '{}',    -- all known phones (E.164)
  ghl_contact_id    text unique,                       -- canonical id when known (multiple NULLs allowed)
  -- Loose pointer to public.customers(id). Intentionally NOT a FK: avoids coupling
  -- this RLS-enabled table to Jason's customers table and tolerates ingest before a
  -- customers row exists. Resolved/joined in code.
  quote_customer_id uuid,
  assigned_to       uuid references auth.users(id) on delete set null,  -- NULL = unclaimed (shared queue)
  tags              text[] not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Identity-resolution lookups (identity.ts match order: ghl_contact_id → email → phone).
create index if not exists dashboard_contacts_emails_gin on public.dashboard_contacts using gin (emails);
create index if not exists dashboard_contacts_phones_gin on public.dashboard_contacts using gin (phones);
create index if not exists dashboard_contacts_primary_email_idx
  on public.dashboard_contacts (primary_email) where primary_email is not null;
create index if not exists dashboard_contacts_assigned_to_idx
  on public.dashboard_contacts (assigned_to) where assigned_to is not null;

-- ════════════════════════════════════════════════════════════════════════════
-- 2. inbox_items — the unified feed (ONE row per conversation, not per message).
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.inbox_items (
  id                   uuid primary key default gen_random_uuid(),
  contact_id           uuid references public.dashboard_contacts(id) on delete cascade,
  source               text not null,        -- ghl | gmail | quotetool | homeworks
  external_id          text not null,        -- conversation id / gmail thread id / quote id
  source_message_id    text,                 -- last message id (drives GHL mark-read on Handled)
  event_type           text,                 -- e.g. 'message' | 'new_quote'
  direction            text,                 -- inbound | outbound (last message)
  channel              text,                 -- sms | email | call | fb | ig | app
  last_message_at      timestamptz,
  preview              text,
  subject              text,
  status               text not null default 'unresponded',  -- unresponded | handled | dismissed
  handled_by           uuid references auth.users(id) on delete set null,  -- NULL when system auto-resolved
  handled_at           timestamptz,
  handled_channel_sync jsonb,                -- per-channel write-back outcome (mark-read/label/opportunity)
  escalation_level     int   not null default 0,    -- 0 none | 1 amber | 2 red | 3 EOD
  notified_levels      int[] not null default '{}', -- escalation levels already emailed (no double-send)
  raw                  jsonb,                -- the source payload (audit/debug)
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  -- Idempotent upsert key: re-ingesting the same conversation updates the row.
  constraint inbox_items_source_external_id_key unique (source, external_id),
  constraint inbox_items_source_check check (source in ('ghl','gmail','quotetool','homeworks')),
  constraint inbox_items_status_check check (status in ('unresponded','handled','dismissed'))
);

-- The /inbox list (open items, newest first) + the escalation cron scan.
create index if not exists inbox_items_status_last_message_idx
  on public.inbox_items (status, last_message_at desc);
create index if not exists inbox_items_status_escalation_idx
  on public.inbox_items (status, escalation_level);
create index if not exists inbox_items_contact_id_idx
  on public.inbox_items (contact_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 3. follow_ups — "due today" reminders (system-created + manual).
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.follow_ups (
  id            uuid primary key default gen_random_uuid(),
  contact_id    uuid references public.dashboard_contacts(id) on delete cascade,
  inbox_item_id uuid references public.inbox_items(id) on delete set null,
  due_at        timestamptz not null,                 -- "due today" evaluated in America/New_York
  reason        text,                                 -- e.g. 'quote_sent_no_reply'
  assigned_to   uuid references auth.users(id) on delete set null,
  status        text not null default 'pending',      -- pending | done | dismissed
  created_by    uuid references auth.users(id) on delete set null,  -- NULL when system-created
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint follow_ups_status_check check (status in ('pending','done','dismissed')),
  -- One system follow-up per (item, reason): makes ensureFollowUp idempotent at the
  -- DB layer (the app-side SELECT-then-INSERT is then just a fast-path, race-safe).
  -- NULLs are distinct in Postgres, so manual follow-ups (null inbox_item_id) are
  -- not constrained by this.
  constraint follow_ups_item_reason_key unique (inbox_item_id, reason)
);

create index if not exists follow_ups_status_due_at_idx on public.follow_ups (status, due_at);
create index if not exists follow_ups_contact_id_idx    on public.follow_ups (contact_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 4. dashboard_activity — append-only audit (who handled/assigned/escalated what).
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.dashboard_activity (
  id            uuid primary key default gen_random_uuid(),
  actor         text,                                 -- auth.users id (as text) or 'system'
  action        text not null,                        -- ingested|assigned|handled|reopened|escalated|dismissed|writeback_ok|writeback_failed
  inbox_item_id uuid references public.inbox_items(id) on delete set null,
  contact_id    uuid references public.dashboard_contacts(id) on delete set null,
  detail        jsonb,
  created_at    timestamptz not null default now()
);

create index if not exists dashboard_activity_inbox_item_idx on public.dashboard_activity (inbox_item_id);
create index if not exists dashboard_activity_created_at_idx on public.dashboard_activity (created_at desc);

-- ════════════════════════════════════════════════════════════════════════════
-- 5. integration_tokens — Gmail OAuth (server-only; deny-all to authenticated).
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.integration_tokens (
  id                uuid primary key default gen_random_uuid(),
  provider          text  not null,                   -- 'gmail'
  account_email     citext not null,
  refresh_token_enc text,                             -- encrypted at rest (Vault/pgcrypto)
  watch_history_id  text,
  watch_expiration  timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint integration_tokens_provider_account_key unique (provider, account_email)
);

-- ════════════════════════════════════════════════════════════════════════════
-- 6. sync_cursors — per-source incremental state + health (powers "synced 12s ago"
--    and the escalation watchdog). Server-only; deny-all to authenticated.
-- ════════════════════════════════════════════════════════════════════════════
create table if not exists public.sync_cursors (
  source       text primary key,                      -- ghl | gmail | quotetool | escalate
  cursor       jsonb,                                  -- e.g. { historyId } / { lastConvDate }
  last_run_at  timestamptz,
  last_status  text,                                   -- ok | error
  last_error   text,
  updated_at   timestamptz not null default now()
);

-- ════════════════════════════════════════════════════════════════════════════
-- Row Level Security + policies
--   • operator tables (contacts, inbox_items, follow_ups): authenticated SELECT+UPDATE,
--     service_role ALL. INSERTs run through the service-role client.
--   • dashboard_activity: authenticated SELECT only (append-only); service_role ALL.
--   • integration_tokens, sync_cursors: NO authenticated policy → deny-all; service_role ALL.
-- service_role bypasses RLS regardless; the explicit policy is documentation + intent.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. dashboard_contacts
alter table public.dashboard_contacts enable row level security;
drop policy if exists dashboard_contacts_select_auth   on public.dashboard_contacts;
drop policy if exists dashboard_contacts_update_auth   on public.dashboard_contacts;
drop policy if exists dashboard_contacts_service_all   on public.dashboard_contacts;
create policy dashboard_contacts_select_auth on public.dashboard_contacts
  for select to authenticated using (true);
create policy dashboard_contacts_update_auth on public.dashboard_contacts
  for update to authenticated using (true) with check (true);
create policy dashboard_contacts_service_all on public.dashboard_contacts
  for all to service_role using (true) with check (true);

-- 2. inbox_items
alter table public.inbox_items enable row level security;
drop policy if exists inbox_items_select_auth on public.inbox_items;
drop policy if exists inbox_items_update_auth on public.inbox_items;
drop policy if exists inbox_items_service_all on public.inbox_items;
create policy inbox_items_select_auth on public.inbox_items
  for select to authenticated using (true);
create policy inbox_items_update_auth on public.inbox_items
  for update to authenticated using (true) with check (true);
create policy inbox_items_service_all on public.inbox_items
  for all to service_role using (true) with check (true);

-- 3. follow_ups
alter table public.follow_ups enable row level security;
drop policy if exists follow_ups_select_auth on public.follow_ups;
drop policy if exists follow_ups_update_auth on public.follow_ups;
drop policy if exists follow_ups_service_all on public.follow_ups;
create policy follow_ups_select_auth on public.follow_ups
  for select to authenticated using (true);
create policy follow_ups_update_auth on public.follow_ups
  for update to authenticated using (true) with check (true);
create policy follow_ups_service_all on public.follow_ups
  for all to service_role using (true) with check (true);

-- 4. dashboard_activity (append-only: authenticated may read, never write)
alter table public.dashboard_activity enable row level security;
drop policy if exists dashboard_activity_select_auth on public.dashboard_activity;
drop policy if exists dashboard_activity_service_all on public.dashboard_activity;
create policy dashboard_activity_select_auth on public.dashboard_activity
  for select to authenticated using (true);
create policy dashboard_activity_service_all on public.dashboard_activity
  for all to service_role using (true) with check (true);

-- 5. integration_tokens (deny-all to authenticated — service_role only)
alter table public.integration_tokens enable row level security;
drop policy if exists integration_tokens_service_all on public.integration_tokens;
create policy integration_tokens_service_all on public.integration_tokens
  for all to service_role using (true) with check (true);

-- 6. sync_cursors (deny-all to authenticated — service_role only)
alter table public.sync_cursors enable row level security;
drop policy if exists sync_cursors_service_all on public.sync_cursors;
create policy sync_cursors_service_all on public.sync_cursors
  for all to service_role using (true) with check (true);

-- ════════════════════════════════════════════════════════════════════════════
-- updated_at triggers (mirrors public.customers_set_updated_at from
-- 2026-06-27-customers-properties.sql). dashboard_activity is append-only → none.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.dashboard_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists dashboard_contacts_updated_at  on public.dashboard_contacts;
create trigger dashboard_contacts_updated_at  before update on public.dashboard_contacts
  for each row execute function public.dashboard_set_updated_at();

drop trigger if exists inbox_items_updated_at on public.inbox_items;
create trigger inbox_items_updated_at before update on public.inbox_items
  for each row execute function public.dashboard_set_updated_at();

drop trigger if exists follow_ups_updated_at on public.follow_ups;
create trigger follow_ups_updated_at before update on public.follow_ups
  for each row execute function public.dashboard_set_updated_at();

drop trigger if exists integration_tokens_updated_at on public.integration_tokens;
create trigger integration_tokens_updated_at before update on public.integration_tokens
  for each row execute function public.dashboard_set_updated_at();

drop trigger if exists sync_cursors_updated_at on public.sync_cursors;
create trigger sync_cursors_updated_at before update on public.sync_cursors
  for each row execute function public.dashboard_set_updated_at();

commit;
