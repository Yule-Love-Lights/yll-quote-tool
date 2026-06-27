-- SHARED jobs table — #83 billing fields + #82 fulfillment_stage; see both specs.
--   docs/jobber-flow/SPEC.md §3 (job statuses) + §5 (data model)   ← #83 (billing)
--   docs/superpowers/specs/2026-06-27-inventory-82-design.md §47, §106-109,
--     §119-123, §141 (Slice 3: Job ID ≠ Quote ID, auto-create on the deposit-paid
--     #38 webhook, design_id → materials, fulfillment Stages Kanban)  ← #82 (fulfillment)
--
-- ONE jobs table for BOTH epics. The deposit-paid Valor webhook is the SINGLE
-- creator (src/lib/jobs.ts createJobFromQuote, idempotent on quote_id): #82's
-- inventory side EXTENDS the same row (sets fulfillment_stage + reads design_id →
-- materials), it never inserts a second job for the same quote.
--
-- ⚠️ MUST BE APPLIED TO THE LIVE SUPABASE BEFORE THE DEPENDENT CODE MERGES.
-- prod auto-deploys `master`; once src/lib/jobs.ts + the webhook write/select
-- these columns, a DB without the table errors createJobFromQuote. Mirrors how
-- the quote-status spine (2026-06-27-quote-status.sql) was rolled out.
--
-- Additive + idempotent (create table/sequence/index if not exists; CREATE OR
-- REPLACE function/trigger). RLS-disabled to match quotes / designs / app_settings
-- (reached only via the service-role client). Roll-forward only.
BEGIN;

-- ── Display-number sequence (seeded at #1000, per SPEC §4.6) ────────────────
-- Independent per type — quote_number_seq already exists (2026-06-27-quote-
-- status.sql); invoice_number_seq arrives with Phase 3.
CREATE SEQUENCE IF NOT EXISTS public.job_number_seq START WITH 1000;

-- Extend the display-number allocator to know the job sequence too. CREATE OR
-- REPLACE keeps the same SECURITY DEFINER RPC the quote spine installed; it
-- stays locked to a known-sequence allowlist so it can't bump an arbitrary
-- relation. Adding 'job_number_seq' here is forward-compatible — the quote
-- allocator keeps working unchanged.
CREATE OR REPLACE FUNCTION public.allocate_display_number(seq_name text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF seq_name NOT IN ('quote_number_seq', 'job_number_seq') THEN
    RAISE EXCEPTION 'allocate_display_number: unknown sequence %', seq_name;
  END IF;
  RETURN nextval(seq_name::regclass);
END;
$$;

-- ── The unified jobs table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Human-friendly sequential display number (Job #1000, …) allocated from
  -- job_number_seq at creation. Job ID (uuid) ≠ Quote ID — own entity (#82 §47).
  job_number    int UNIQUE,

  -- From-Quote link: which quote this job was created from. The job snapshots
  -- the quote's line items at creation (later quote edits don't propagate;
  -- amendments are explicit — #83 Phase 4).
  quote_id      uuid REFERENCES public.quotes(id),

  -- The live editable design (#27) this job draws materials from (#82: design_id
  -- → scene → materials projection). Nullable — set from the quote's design at
  -- creation when present.
  design_id     uuid,

  -- Stable customer/property identity. Nullable now — populated when #83 Phase 5
  -- (customers + properties tables) lands.
  customer_id   uuid,
  property_id   uuid,

  -- one_off (seasonal) | permanent (Glow365 recurring billing deferred). Carried
  -- from the quote's service_type at creation.
  type          text NOT NULL DEFAULT 'one_off',

  -- #83 BILLING lifecycle status (SPEC §3): to_schedule → scheduled → installed
  -- → requires_invoicing → done (+ cancelled). Free text (canonical set enforced
  -- in code: src/lib/jobs.ts JOB_STATUSES) so a bad write can't 500 the row.
  status        text NOT NULL DEFAULT 'to_schedule',

  -- ⚠️ #82 owns this — the materials/fulfillment Kanban axis (a DIFFERENT board
  -- from the dashboard's Quotes WorkflowBoard). Managed by Inventory epic #82
  -- (Slice 3); the #83 billing side leaves it NULL.
  fulfillment_stage text,

  -- Snapshot of the quote's priced line items at creation (jsonb). The job is a
  -- snapshot, not a live view of the quote.
  line_items    jsonb,

  -- Install date — synced from home.works later (#84). Scheduling is out of this
  -- tool; the job just carries the date.
  install_date  date,

  -- When the job was marked done/installed-complete (#83 invoice trigger, Phase 3).
  completed_at  timestamptz,

  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.jobs DISABLE ROW LEVEL SECURITY;

-- One job per quote — the auto-create is idempotent in code, but this guards
-- against a concurrent double-insert at the DB level too. Partial: only the
-- rows actually linked to a quote.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_quote_id_key
  ON public.jobs (quote_id)
  WHERE quote_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON public.jobs (created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON public.jobs (status);

-- Keep updated_at fresh on every write (mirrors app_settings / inventory_catalog).
CREATE OR REPLACE FUNCTION public.jobs_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS jobs_updated_at_trigger ON public.jobs;
CREATE TRIGGER jobs_updated_at_trigger
  BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.jobs_set_updated_at();

COMMIT;
