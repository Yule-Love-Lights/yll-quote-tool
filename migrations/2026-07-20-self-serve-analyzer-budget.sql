-- =====================================================================
-- self_serve_analyzer_budget — the public self-serve estimator's aggregate
-- daily SPEND guard (ledger self-serve). /api/estimate spends money per accepted
-- request (Claude analyzer + Google Maps). Per-IP rate limiting caps one
-- attacker's rate; this caps the TOTAL across all IPs so a distributed bot can't
-- run up the bill. One row per UTC day holding the count of paid analyzer runs;
-- the route consumes one unit before spending and stops once the day's count
-- passes SELF_SERVE_DAILY_ANALYZER_CAP (env; default 300).
--
-- RLS ENABLED, ZERO POLICIES — service-role only (the route + the RPC below run
-- server-side). Matches the website_leads / self_serve_estimates pattern.
--
-- HOW TO APPLY: paste into the Supabase SQL Editor and Run. Idempotent; safe to
-- re-run (the function is CREATE OR REPLACE).
-- =====================================================================

create table if not exists public.self_serve_analyzer_budget (
  day   date primary key default (now() at time zone 'utc')::date,
  count integer not null default 0
);

alter table public.self_serve_analyzer_budget enable row level security;

-- Atomic consume-one-unit: upsert today's row incrementing the count, and return
-- the NEW count. One statement, so concurrent lambdas across regions can't race
-- (the whole INSERT ... ON CONFLICT DO UPDATE is atomic under the row lock). The
-- route compares the returned count against the cap. Runs under the service-role
-- (BYPASSRLS) that the server uses, so no SECURITY DEFINER is needed.
create or replace function public.bump_self_serve_analyzer_budget()
returns integer
language sql
as $$
  insert into public.self_serve_analyzer_budget (day, count)
  values ((now() at time zone 'utc')::date, 1)
  on conflict (day)
    do update set count = self_serve_analyzer_budget.count + 1
  returning count;
$$;
