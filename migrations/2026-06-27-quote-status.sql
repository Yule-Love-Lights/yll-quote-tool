-- Status spine + display numbers (ledger #83, Phase 1 Slice A).
--
-- Replaces the implicit timestamp-derived quote state with an explicit `status`
-- column, adds the portal decline reason, and gives quotes a sequential
-- human-friendly display number (Quote #) alongside the UUID. See
-- docs/jobber-flow/SPEC.md §3 (lifecycle) + §4.6 (display IDs).
--
-- ⚠️ MUST BE APPLIED TO THE LIVE SUPABASE BEFORE THE DEPENDENT CODE MERGES.
-- prod auto-deploys `master`; once src/lib/quotes.ts selects/writes these
-- columns, a DB without them errors every saveQuote / listQuotes. This mirrors
-- exactly how the ghl_stage_synced_at column (2026-06-27-quotes-add-ghl-stage-
-- sync.sql) and the created_by reservation were handled.
--
-- Additive + idempotent (add column if not exists / create sequence if not
-- exists / guarded backfill). Roll-forward only — to remove later, write a new
-- DROP migration rather than editing this file.
BEGIN;

-- ── Columns ────────────────────────────────────────────────────────────────

-- The explicit lifecycle status. Free text (not a CHECK/enum) so Slice B can
-- add states without a schema migration and a bad write can't 500 the row; the
-- canonical set is enforced in code (src/lib/quoteStatus.ts QUOTE_STATUSES).
-- Nullable: legacy rows stay NULL and read via deriveStatus() until backfilled
-- below / re-stamped by the write paths.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS status text;

-- Customer's reason when they decline from the portal (Slice B writes it). NULL
-- on every non-declined quote.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS decline_reason text;

-- Sequential, human-friendly display number (Quote #1000, #1001, …). Allocated
-- from quote_number_seq on first save; the UUID stays the PK + portal token, so
-- this number is display-only and never appears in a URL (SPEC §4.6 PII note).
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS quote_number int;

-- ── Display-number sequence (seeded at #1000 per SPEC §4.6 recommendation) ──
-- Start at 1000 so early real customers don't see "#1". Independent per type;
-- job_number_seq / invoice_number_seq arrive with Phase 2/3.
CREATE SEQUENCE IF NOT EXISTS public.quote_number_seq START WITH 1000;

-- SECURITY DEFINER RPC so the app's service-role client can allocate the next
-- value without raw SQL access. Locked to the quote sequence (validated
-- argument) so it can't be used to bump an arbitrary relation. Same RPC shape
-- as match_training_examples.
CREATE OR REPLACE FUNCTION public.allocate_display_number(seq_name text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF seq_name <> 'quote_number_seq' THEN
    RAISE EXCEPTION 'allocate_display_number: unknown sequence %', seq_name;
  END IF;
  RETURN nextval('public.quote_number_seq');
END;
$$;

-- ── Backfill status from existing timestamps ───────────────────────────────
-- Same precedence as deriveStatus(): deposit_paid → booked, approved → approved,
-- viewed → viewed, sent → sent, else draft. Guarded on `status IS NULL` so a
-- re-run never clobbers a status a write path has since set. We do NOT backfill
-- quote_number — existing rows simply have none until they're next saved (their
-- truncated-UUID display, #77, still works); a bulk backfill would be a separate,
-- deliberate one-off, not part of this additive migration.
UPDATE public.quotes
SET status = CASE
  WHEN deposit_paid_at IS NOT NULL THEN 'booked'
  WHEN customer_approved_at IS NOT NULL THEN 'approved'
  WHEN viewed_at IS NOT NULL THEN 'viewed'
  WHEN quote_sent_at IS NOT NULL THEN 'sent'
  ELSE 'draft'
END
WHERE status IS NULL;

-- Display-number uniqueness (allocated values are already unique; this guards
-- against a manual double-write). Partial — only the rows that have a number.
CREATE UNIQUE INDEX IF NOT EXISTS quotes_quote_number_key
  ON public.quotes (quote_number)
  WHERE quote_number IS NOT NULL;

COMMIT;
