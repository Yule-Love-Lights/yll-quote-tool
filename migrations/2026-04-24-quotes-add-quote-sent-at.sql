-- Admin-triggered "Send Quote to Customer" timestamp.
-- Distinct from customer_approved_at and homeworks_sent_at:
--   quote_sent_at        = admin clicked "Send Quote to Customer" on /quote/new
--                          (portal URL was handed off, HL stage moved to Bid Sent)
--   customer_approved_at = customer clicked "Approve" on the portal
--   homeworks_sent_at    = Zapier webhook to home.works succeeded
--
-- Lets the admin UI distinguish "draft" vs. "sent, awaiting customer"
-- vs. "approved" states without having to infer from HL stage alone.
--
-- Roll-forward only. Idempotent — safe on existing DBs.
BEGIN;

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS quote_sent_at timestamptz;

-- Partial index for the admin dashboard's "sent but not yet approved" bucket.
-- Tiny — only holds rows where the customer hasn't acted yet.
CREATE INDEX IF NOT EXISTS quotes_awaiting_customer_idx
  ON public.quotes (quote_sent_at DESC)
  WHERE quote_sent_at IS NOT NULL AND customer_approved_at IS NULL;

COMMIT;
