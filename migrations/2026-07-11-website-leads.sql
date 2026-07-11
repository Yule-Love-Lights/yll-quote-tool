-- =====================================================================
-- website_leads — lead-capture table for the WordPress custom quote-request
-- forms (yulelovelights.com → POST /api/leads). Replaces the old plugin that
-- routed EVERY lead into the Christmas pipeline regardless of the service the
-- visitor actually asked about — this table is the source of truth / retry
-- queue, written FIRST on every submission; the route then syncs each row to
-- the correct per-service HighLevel pipeline (src/lib/leads/leadService.ts).
--
-- sync_status:
--   'pending'  — row saved, GHL sync not yet attempted or it failed (retry queue)
--   'synced'   — contact + opportunity created/updated in GHL
--   'spam'     — honeypot or too-fast submit; row kept for visibility, GHL skipped
--   'deferred' — service resolved but its GHL pipeline env vars aren't set yet
--                (e.g. landscape pre-launch)
--
-- RLS ENABLED, ZERO POLICIES — matches the #90 all-tables hardening pattern
-- (2026-06-28-enable-rls-all-tables.sql): the service-role key (BYPASSRLS) is
-- the only path that ever reaches this table (POST /api/leads runs server-side
-- only), so RLS with no policies denies anon/authenticated entirely while the
-- real path keeps working unchanged.
--
-- HOW TO APPLY: paste into the Supabase SQL Editor and Run. Idempotent; safe
-- to re-run.
-- =====================================================================

create table if not exists public.website_leads (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  form_variant        text not null,               -- which embedded form (e.g. 'hero', 'sticky', 'footer')
  service             text not null,                -- christmas | permanent | event-wedding | landscape
  name                text not null,
  email               text not null,
  phone               text not null,
  address             text,
  notes               text,
  consent             boolean not null default false,
  utm                 jsonb,
  landing_url         text,
  ip                  text,
  ghl_contact_id      text,
  ghl_opportunity_id  text,
  sync_status         text not null default 'pending',
  sync_error          text,
  is_test             boolean not null default false
);

-- Newest-first admin views / cleanup.
create index if not exists website_leads_created_at_idx
  on public.website_leads (created_at);

-- The rate-limit query (count from this IP in the last hour).
create index if not exists website_leads_ip_created_at_idx
  on public.website_leads (ip, created_at);

-- Defense in depth (mirrors the #90 all-tables hardening + permanent_training_
-- examples): the service-role key is the only path that ever reaches this
-- table, so RLS with ZERO policies denies anon/authenticated entirely while
-- every server path keeps working unchanged.
alter table public.website_leads enable row level security;
