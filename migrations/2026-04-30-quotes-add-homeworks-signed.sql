-- Inbound webhook from home.works (via Zapier) when the customer signs
-- their contract on home.works's side. Captures the moment + an
-- optional contract reference for our records, and triggers the final
-- HighLevel stage move to ⏰Approved.
--
-- Column timeline for a fully-completed quote:
--   created_at            ─ quote saved on /quote/new
--   quote_sent_at         ─ admin clicked "Send to Customer"
--   customer_approved_at  ─ customer clicked "Approve" on portal
--   homeworks_sent_at     ─ outbound Zapier webhook to home.works succeeded
--   homeworks_signed_at   ─ inbound webhook from home.works (this one)
--
-- Roll-forward only. Idempotent — safe on existing DBs.
BEGIN;

-- Set when home.works tells us the customer signed the contract.
-- NULL = not yet signed (most quotes will sit here for hours/days
-- between approval and signing).
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS homeworks_signed_at timestamptz;

-- Optional reference id from home.works's side. Lets us round-trip
-- to the original contract if we ever need to look one up. Free-form
-- text because home.works's id format is theirs to define and we
-- don't want to over-constrain.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS homeworks_contract_id text;

-- Admin dashboard "fully booked, signed" bucket — partial index keeps
-- it tiny (only signed rows).
CREATE INDEX IF NOT EXISTS quotes_signed_idx
  ON public.quotes (homeworks_signed_at DESC)
  WHERE homeworks_signed_at IS NOT NULL;

COMMIT;
