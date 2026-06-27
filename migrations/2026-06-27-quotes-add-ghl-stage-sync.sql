-- Audit fix (send-route-ghl-sync-state, finding #32): make the HighLevel
-- pipeline-stage sync on "Send Quote to Customer" durable + reconcilable.
--
-- Before this, the GHL "Bid Sent" stage move on POST /api/quotes/[id]/send
-- was best-effort: a failure was reported only via stageError in the response
-- JSON (which the customer's-side caller ignores), the quote was still stamped
-- quote_sent_at, and the only durable trace was a console line. Staff had no
-- way to find a quote whose pipeline card never advanced, and no retry path.
--
-- These two additive, nullable columns record the outcome of the GHL stage
-- sync separately from quote_sent_at so:
--   - a NULL ghl_stage_synced_at + non-null quote_sent_at = "sent locally but
--     the pipeline card never moved" → the reconcile/retry bucket
--   - ghl_sync_error holds the last failure reason for debugging
--
-- Roll-forward only. Idempotent — safe on existing DBs.
BEGIN;

-- Set when the GHL opportunity was successfully moved to "Bid Sent" (and the
-- card title/value refreshed). NULL = the stage move has not yet succeeded for
-- this quote — either never attempted (integration unconfigured) or it threw.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS ghl_stage_synced_at timestamptz;

-- Last GHL stage-sync failure reason (cleared on success). Free-form text for
-- staff debugging; not customer-facing.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS ghl_sync_error text;

-- Admin "sent but pipeline card never advanced" reconcile bucket — partial
-- index keeps it tiny (only the rows that need a retry).
CREATE INDEX IF NOT EXISTS quotes_ghl_stage_unsynced_idx
  ON public.quotes (quote_sent_at DESC)
  WHERE quote_sent_at IS NOT NULL AND ghl_stage_synced_at IS NULL;

COMMIT;
