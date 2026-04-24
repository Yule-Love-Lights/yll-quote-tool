-- Integration link columns on the quotes table. Lets us round-trip between
-- the AI Quote Tool, HighLevel, and home.works without needing to search
-- by name/email fuzzy match every time.
--
-- All columns nullable + idempotent — safe to run on an existing database
-- with live data. Quotes that pre-date this migration keep working as
-- manual-entry quotes (no CRM link, no home.works link).
--
-- Roll-forward only. If we need to remove these later, write a new
-- DROP COLUMN migration rather than editing this file.

BEGIN;

-- HighLevel contact this quote was built for. NULL = quote was started
-- from scratch without a CRM lookup (manual entry). Kept as text because
-- GHL uses 24-char IDs, not UUIDs, and we don't validate on insert.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS highlevel_contact_id text;

-- HighLevel opportunity / pipeline card created when this quote was saved.
-- NULL = opportunity creation failed or was skipped (e.g., integration
-- unconfigured). We don't fail the quote save on GHL errors — the quote
-- is still valuable as a local record.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS highlevel_opportunity_id text;

-- Timestamp when this quote was pushed to home.works (via Zapier webhook).
-- NULL = never sent. Admin UI checks this to show "Sent to home.works
-- at 3:42 PM" vs. a "Send" button.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS homeworks_sent_at timestamptz;

-- Whatever Zapier's catch hook returns when we POST the quote — usually
-- {"status":"success","request_id":"..."}. Stored for debugging so if a
-- Zap run fails silently we have the hook response to cross-reference
-- against Zap History.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS homeworks_webhook_response jsonb;

-- Customer approval timestamp. Set when the customer clicks "Approve &
-- Pay Deposit" on the /portal/[quoteId] page. Once set, the quote is
-- immutable — the UI should refuse further edits and the admin panel
-- should show an "approved" badge.
-- Distinction from homeworks_sent_at:
--   customer_approved_at = the human clicked the button
--   homeworks_sent_at    = the Zapier webhook successfully fired
-- These are almost always within the same second, but if Zapier is down
-- we want to preserve the fact that the customer HAS approved, even
-- though we couldn't deliver to home.works yet. The admin UI can then
-- show "approved but webhook failed" and offer a manual resend.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS customer_approved_at timestamptz;

-- Frozen snapshot of the quote at the moment of approval. Contains:
--   - packageId chosen (A/B/C/D)
--   - selected line-item IDs
--   - computed total + deposit at approval time
--   - customer info copy
-- This is the "save as a package" artifact — an immutable record of
-- exactly what the customer agreed to, separate from the live quote
-- row which could theoretically still be edited by an admin.
-- Stored as jsonb so the structure can evolve without migrations.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS approval_snapshot jsonb;

-- Index for the two lookup paths we'll actually use:
--   1. "Is there already a quote for this HighLevel contact?" (dedup on quote create)
--   2. "Show me all quotes that haven't been sent to home.works yet"
-- The partial index on homeworks_sent_at IS NULL keeps the index tiny —
-- only tracks the backlog, not the full history.
CREATE INDEX IF NOT EXISTS quotes_highlevel_contact_id_idx
  ON public.quotes (highlevel_contact_id)
  WHERE highlevel_contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS quotes_homeworks_pending_idx
  ON public.quotes (created_at DESC)
  WHERE homeworks_sent_at IS NULL;

COMMIT;
