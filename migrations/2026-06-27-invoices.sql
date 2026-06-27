-- Invoices — the money tail of the Jobber-flow (ledger #83, Phase 3).
--   docs/jobber-flow/SPEC.md §4.3 (invoices) + §5 (data model)
--   docs/jobber-flow/PLAN.md Phase 3
--
-- An invoice is auto-created when a job is marked installed/complete. It is the
-- FULL total with the already-paid deposit applied as a payment → the remaining
-- balance (mirrors Jobber's invoice math: balance = total − deposit paid). The
-- deposit applied is the ACTUAL amount charged at booking (quotes.deposit_amount_usd),
-- not a recomputed 50% — so an amended order (Phase 4) invoices correctly.
--
-- ⚠️ MUST BE APPLIED TO THE LIVE SUPABASE BEFORE THE DEPENDENT CODE MERGES.
-- prod auto-deploys `master`; once src/lib/invoices.ts writes/selects these
-- columns, a DB without the table errors the query. Same rollout as the jobs
-- table (2026-06-27-jobs.sql) and the quote-status spine.
--
-- Additive + idempotent (create table/sequence/index if not exists; CREATE OR
-- REPLACE function/trigger). RLS-disabled to match quotes / jobs / designs
-- (reached only via the service-role client). Roll-forward only.
BEGIN;

-- ── Display-number sequence (seeded at #1000, per SPEC §4.6) ────────────────
-- Third independent sequence; quote_number_seq + job_number_seq already exist.
CREATE SEQUENCE IF NOT EXISTS public.invoice_number_seq START WITH 1000;

-- Extend the display-number allocator to know the invoice sequence too. CREATE
-- OR REPLACE keeps the same SECURITY DEFINER RPC; it stays locked to a
-- known-sequence allowlist so it can't bump an arbitrary relation. Adding
-- 'invoice_number_seq' is forward-compatible — quote/job allocation is unchanged.
CREATE OR REPLACE FUNCTION public.allocate_display_number(seq_name text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF seq_name NOT IN ('quote_number_seq', 'job_number_seq', 'invoice_number_seq') THEN
    RAISE EXCEPTION 'allocate_display_number: unknown sequence %', seq_name;
  END IF;
  RETURN nextval(seq_name::regclass);
END;
$$;

-- ── The invoices table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Human-friendly sequential display number (Invoice #1000, …) from
  -- invoice_number_seq at creation. UUID stays the pk; the number is display-only.
  invoice_number  int UNIQUE,

  -- The job this invoice bills for (one invoice per job — auto-created at
  -- installed/complete). From-Quote link kept too for direct reference.
  job_id          uuid REFERENCES public.jobs(id),
  quote_id        uuid REFERENCES public.quotes(id),

  -- Stable customer identity (#83 Phase 5). Carried from the job at creation.
  customer_id     uuid,

  -- Money breakdown, snapshotted from the quote's priced result at creation.
  -- subtotal = pre-discount line total; discount = all discounts; tax = sales tax
  -- (0 when tax_overridden); total = what's owed in full.
  subtotal        numeric(10, 2) NOT NULL DEFAULT 0,
  discount        numeric(10, 2) NOT NULL DEFAULT 0,
  tax             numeric(10, 2) NOT NULL DEFAULT 0,
  total           numeric(10, 2) NOT NULL DEFAULT 0,

  -- The deposit ALREADY PAID at booking (quotes.deposit_amount_usd) applied as a
  -- payment. balance = max(0, total − deposit_applied). credit_note is the
  -- overpayment (deposit > total, e.g. an amended-down order) — a MANUAL Valor
  -- refund, surfaced here (mirrors Phase 4's credit_note; no refund integration).
  deposit_applied numeric(10, 2) NOT NULL DEFAULT 0,
  balance         numeric(10, 2) NOT NULL DEFAULT 0,
  credit_note     numeric(10, 2) NOT NULL DEFAULT 0,

  -- Manual tax-override (rare exemptions). When true the math zeroes tax. The
  -- toggle action is an operator surface (deferred to #81); the column + math
  -- exist now.
  tax_overridden  boolean NOT NULL DEFAULT false,

  -- Lifecycle: draft → awaiting_payment → paid (+ cancelled). Free text
  -- (canonical set enforced in code: src/lib/invoiceStatus.ts) so a bad write
  -- can't 500 the row. No AR/aging view (Naldo opted out).
  status          text NOT NULL DEFAULT 'draft',

  -- Set when the balance is collected (Phase 3 collection, gated on #81 + the
  -- auto-charge-vs-pay-link decision). Nullable until then.
  valor_balance_txn_id text,
  valor_receipt_url    text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.invoices DISABLE ROW LEVEL SECURITY;

-- One invoice per job — createInvoiceFromJob is idempotent in code; this guards a
-- concurrent double-insert at the DB level. Partial: only rows linked to a job.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_job_id_key
  ON public.invoices (job_id)
  WHERE job_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS invoices_created_at_idx ON public.invoices (created_at DESC);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON public.invoices (status);

-- Keep updated_at fresh on every write (mirrors jobs_set_updated_at).
CREATE OR REPLACE FUNCTION public.invoices_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invoices_updated_at_trigger ON public.invoices;
CREATE TRIGGER invoices_updated_at_trigger
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.invoices_set_updated_at();

COMMIT;
