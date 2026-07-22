-- =====================================================================
-- job_material_actuals — what a job REALLY used, captured from the field
-- (text-ops bot Phase 2, ledger #168). Today prepareJobMaterials deducts the
-- ESTIMATED BOM at prep time and nothing ever records what the crew actually
-- consumed; this table closes that loop.
--
-- One row per (job, sku) submission. The bot writes these when a crew member
-- texts "job 142 done — 2 boxes C9, 30 clips"; the stock true-up then adjusts
-- on-hand by the DIFFERENCE between estimate and actual (see materialActuals.ts).
--
-- jobs.materials_actualized_at is the IDEMPOTENCY CLAIM — the same guard
-- prepareJobMaterials uses with stock_decremented_at. A second "job 142 done"
-- (a retry, a double-tap, two crew members on the same job) finds the stamp
-- already set and applies nothing, so stock can never be trued up twice.
--
-- RLS ENABLED, ZERO POLICIES — service-role only (the bot runs server-side).
-- Matches the website_leads / self_serve_estimates pattern.
--
-- HOW TO APPLY: paste into the Supabase SQL Editor and Run. Idempotent; safe to
-- re-run.
-- =====================================================================

create table if not exists public.job_material_actuals (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.jobs(id) on delete cascade,
  sku         text not null,
  qty         integer not null default 0 check (qty >= 0),
  -- What the crew typed, kept verbatim for dispute/debug ("2 boxes C9").
  raw_text    text,
  -- Telegram chat id (or 'staff:<label>') that submitted it — the audit trail.
  recorded_by text,
  created_at  timestamptz not null default now()
);

create index if not exists job_material_actuals_job_id_idx
  on public.job_material_actuals (job_id);

alter table public.job_material_actuals enable row level security;

-- The idempotency claim for the stock true-up. NULL = actuals never recorded.
alter table public.jobs
  add column if not exists materials_actualized_at timestamptz;

-- =====================================================================
-- bot_pending_actions — the confirm-yes gate's memory.
--
-- Every sensitive bot write echoes a one-line summary and waits for "yes"
-- before it runs, so a misread text is harmless until confirmed. Lambdas are
-- stateless, so the pending action has to live in the DB between the two
-- messages. Rows are consumed ATOMICALLY (set consumed_at WHERE consumed_at is
-- null) so a double "yes" can only execute once.
-- =====================================================================

create table if not exists public.bot_pending_actions (
  id          uuid primary key default gen_random_uuid(),
  chat_id     text not null,
  -- The SENDER, not the room: in a group chat each person confirms their own
  -- pending action, and roles are keyed to the user too.
  user_id     text not null,
  tool        text not null,
  args        jsonb not null default '{}'::jsonb,
  -- The exact confirm line shown to the user, replayed in the audit entry.
  summary     text not null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  consumed_at timestamptz
);

create index if not exists bot_pending_actions_open_idx
  on public.bot_pending_actions (chat_id, user_id, created_at desc)
  where consumed_at is null;

alter table public.bot_pending_actions enable row level security;

-- =====================================================================
-- bot_audit_log — who asked the bot to do what, and what happened.
--
-- Every write the bot performs lands here (the plan's non-negotiable guardrail),
-- including denied attempts, so an unexpected stock or CRM change is always
-- traceable back to a person and a message.
-- =====================================================================

create table if not exists public.bot_audit_log (
  id         uuid primary key default gen_random_uuid(),
  chat_id    text,
  user_id    text,
  role       text,
  tool       text not null,
  args       jsonb not null default '{}'::jsonb,
  outcome    text not null,
  detail     text,
  created_at timestamptz not null default now()
);

create index if not exists bot_audit_log_created_at_idx
  on public.bot_audit_log (created_at desc);

alter table public.bot_audit_log enable row level security;
