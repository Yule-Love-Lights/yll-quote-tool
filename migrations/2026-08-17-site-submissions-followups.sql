-- Site-submission follow-ups (#195): staff triage state, sync retry bookkeeping,
-- and the nominee contact record. All additive, nullable or defaulted.
--
-- PROVENANCE (row 188 true-up, committed 2026-08-26): this migration was
-- APPLIED TO PROD on 2026-08-17 (Supabase migration history version
-- 20260817123021, name `site_submissions_followups`) but the file itself was
-- never committed to the repo — a violation of the AGENTS.md same-PR rule,
-- found by the row-188 drift audit. The statements below are pulled VERBATIM
-- from `supabase_migrations.schema_migrations` for that version. DO NOT
-- re-apply to the current prod project (everything here is already live);
-- the file exists so a fresh environment built from `migrations/` gets the
-- same schema, and so FULL-SCHEMA.sql's fold-in has a source of truth.

alter table public.site_submissions
  add column if not exists handled_at timestamptz;
alter table public.site_submissions
  add column if not exists handled_by text;

create index if not exists site_submissions_unhandled_idx
  on public.site_submissions (created_at desc)
  where handled_at is null;

alter table public.site_submissions
  add column if not exists retry_count integer not null default 0;
alter table public.site_submissions
  add column if not exists last_retried_at timestamptz;

create index if not exists site_submissions_retry_idx
  on public.site_submissions (last_retried_at nulls first, created_at)
  where sync_status in ('pending', 'error');

-- A nomination names a THIRD party. They become a contact only when the nominator
-- confirms on the form that the household agreed to be contacted.
alter table public.site_submissions
  add column if not exists nominee_consent boolean not null default false;
alter table public.site_submissions
  add column if not exists nominee_ghl_contact_id text;
alter table public.site_submissions
  add column if not exists nominee_sync_error text;
