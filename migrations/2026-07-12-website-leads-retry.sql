-- =====================================================================
-- website_leads retry bookkeeping (#leads — GHL-outage recovery). Adds the
-- attempt counter + last-attempt timestamp the retry worker
-- (src/lib/leads/leadRetry.ts) uses to bound automatic retries and to surface
-- stuck rows on /admin/leads.
--
-- MIGRATION ORDER: additive + nullable/defaulted columns → this ships
-- MIGRATION-FIRST (apply BEFORE the code that reads/writes retry_count deploys).
-- Old rows get retry_count = 0, last_retried_at = NULL — exactly what the worker
-- treats as "never retried, most urgent" (nulls-first ordering).
--
-- sync_status gains a new TERMINAL value 'failed' (retry attempts exhausted —
-- parked for a manual re-drive from /admin/leads). The column has NO CHECK
-- constraint (see the base table migration), so no constraint change is needed;
-- this is documented here only for the record. Existing values unchanged:
--   'pending' | 'synced' | 'spam' | 'deferred' | 'rate_limited' | 'failed'(new)
--
-- HOW TO APPLY: paste into the Supabase SQL Editor and Run. Idempotent; safe to
-- re-run.
-- =====================================================================

alter table public.website_leads
  add column if not exists retry_count integer not null default 0;

alter table public.website_leads
  add column if not exists last_retried_at timestamptz;

-- The retry worker's scan: the still-stuck rows, oldest attempt first. Partial
-- index (only pending/deferred rows are ever selected) keeps it tiny — the
-- stuck set is a handful of rows even during an outage.
create index if not exists website_leads_retry_idx
  on public.website_leads (last_retried_at)
  where sync_status in ('pending', 'deferred');
