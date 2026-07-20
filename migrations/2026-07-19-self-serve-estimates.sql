-- =====================================================================
-- self_serve_estimates — accuracy telemetry for the customer self-serve
-- estimator (Phase A, ledger self-serve slice 2b).
--
-- One row per self-serve quote at the moment /api/estimate priced it: the
-- RANGE the customer was shown (estimate_low..estimate_high) + the analyzer's
-- confidence. This is written at creation and NEVER updated — the "verified
-- final" price is read live from the linked quotes.total, so the dashboard can
-- compare "what we quoted instantly" vs "what staff confirmed" and surface the
-- Phase A→B go/no-go accuracy (how often the staff-final landed inside the
-- shown range). Keeping it in its own table (not the quotes.inputs jsonb) means
-- a staff re-Calculate can't overwrite the original estimate.
--
-- quote_id FK → quotes(id) ON DELETE CASCADE: deleting a quote (incl. the test-
-- data sweep) drops its estimate row too, so telemetry never references a ghost.
--
-- RLS ENABLED, ZERO POLICIES — matches the #90 all-tables hardening pattern:
-- the service-role key (BYPASSRLS) is the only path that touches this table
-- (POST /api/estimate + the dashboard loader run server-side only), so RLS with
-- no policies denies anon/authenticated entirely while the real path is
-- unchanged.
--
-- HOW TO APPLY: paste into the Supabase SQL Editor and Run. Idempotent; safe to
-- re-run.
-- =====================================================================

create table if not exists public.self_serve_estimates (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  quote_id       uuid not null references public.quotes(id) on delete cascade,
  estimate_low   numeric(10,2) not null,
  estimate_high  numeric(10,2) not null,
  -- The RAW engine total at estimate time (the number the range was built from).
  -- The dashboard compares the quote's LIVE total against this to tell whether
  -- staff actually re-priced (verified) the quote vs sent it unchanged — an
  -- unchanged send is trivially in-range and must not inflate the accuracy tile.
  estimate_total numeric(10,2),
  confidence     text
);

-- Idempotency for estimate_total (slice-2b review fix): the `create table if not
-- exists` above is a no-op on a DB where an EARLIER version of this table was
-- already created WITHOUT this column, which would silently leave estimate_total
-- missing (and defeat the accuracy metric). Add it explicitly. Harmless when the
-- create just ran with the column present.
alter table public.self_serve_estimates add column if not exists estimate_total numeric(10,2);

-- Dashboard join (self_serve_estimates → quotes) + newest-first reads.
create index if not exists self_serve_estimates_quote_id_idx
  on public.self_serve_estimates (quote_id);
create index if not exists self_serve_estimates_created_at_idx
  on public.self_serve_estimates (created_at);

-- Defense in depth (mirrors website_leads + the #90 all-tables hardening): the
-- service-role key is the only path that ever reaches this table, so RLS with
-- ZERO policies denies anon/authenticated entirely while every server path
-- keeps working unchanged.
alter table public.self_serve_estimates enable row level security;
