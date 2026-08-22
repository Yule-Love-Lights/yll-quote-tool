-- Site-submission follow-ups (#195): staff triage state, sync retry bookkeeping,
-- and the nominee contact record.
--
-- MIGRATION ORDER: additive columns only, all nullable or defaulted, and the code
-- that reads them ships after. Existing rows land as "never handled, never
-- retried, no nominee contact", which is exactly what the new code treats as the
-- starting state.

-- ── Staff triage ────────────────────────────────────────────────────────────
-- Without this, every submission looks identical forever and there is no way to
-- tell a newsletter signup someone already actioned from one nobody has read.
alter table public.site_submissions
  add column if not exists handled_at timestamptz;
alter table public.site_submissions
  add column if not exists handled_by text;

-- The admin default view is "still needs attention", so index the unhandled rows.
create index if not exists site_submissions_unhandled_idx
  on public.site_submissions (created_at desc)
  where handled_at is null;

-- ── GHL sync retry ──────────────────────────────────────────────────────────
-- Mirrors public.website_leads' retry bookkeeping. A transient GHL outage used to
-- lose the contact tag permanently: the row recorded sync_status='error' and
-- nothing in the app could ever re-drive it.
alter table public.site_submissions
  add column if not exists retry_count integer not null default 0;
alter table public.site_submissions
  add column if not exists last_retried_at timestamptz;

-- The retry worker's scan: still-unsynced rows, oldest attempt first. Partial so
-- it stays tiny, and nulls-first ordering means "never retried" is most urgent.
create index if not exists site_submissions_retry_idx
  on public.site_submissions (last_retried_at nulls first, created_at)
  where sync_status in ('pending', 'error');

-- ── Nominee contact (Light Up For Hope) ─────────────────────────────────────
-- A nomination names a THIRD party. Until now they were stored for staff only and
-- never entered the CRM, because they never consented to anything.
--
-- Naldo asked (2026-08-17) for the nominee to become a contact and enter
-- automation. Automation here means marketing messages, and messaging someone who
-- never agreed carries real per-message exposure, so the trigger is the
-- nominator confirming on the form that the household agreed to be contacted.
-- nominee_consent records that answer; nominee_ghl_contact_id records the
-- resulting contact. No consent means no contact and no automation, exactly as
-- before.
alter table public.site_submissions
  add column if not exists nominee_consent boolean not null default false;
alter table public.site_submissions
  add column if not exists nominee_ghl_contact_id text;
alter table public.site_submissions
  add column if not exists nominee_sync_error text;
