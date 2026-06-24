-- Valor (ValorPayTech) deposit-payment columns on the quotes table (#38).
--
-- The customer pays their 50% deposit via an embedded Passage.js checkout on
-- the portal. Valor confirms the payment with a signed webhook; on that
-- confirmation we stamp these columns, move the HighLevel card to ⏰Approved,
-- and email the receipt. Staff later charge the remaining 50% balance MANUALLY
-- in the Valor portal using the vaulted card — we build no auto-charge.
--
-- Column timeline for a fully-paid quote:
--   created_at            ─ quote saved on /quote/new
--   quote_sent_at         ─ admin clicked "Send to Customer"
--   customer_approved_at  ─ customer clicked "Approve" on portal (snapshot frozen)
--   valor_order_ref       ─ set when the deposit checkout is opened (/pay)
--   deposit_paid_at       ─ Valor webhook confirmed the deposit (response_code "00")
--
-- All columns nullable + idempotent — safe to run on a live database. Quotes
-- that pre-date this migration keep working. Roll-forward only: to remove these
-- later, write a new DROP COLUMN migration rather than editing this file.

BEGIN;

-- Our reference embedded in the GetClientToken call and echoed back by Valor's
-- webhook, so the webhook can map the payment to this quote (same "round-trip
-- our id" pattern as the home.works signed webhook). Set when the deposit
-- checkout opens; the webhook looks the quote up by it.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS valor_order_ref text;

-- The deposit amount (USD) we asked Valor to charge, computed server-side from
-- the quote at checkout-open time. Lets the webhook sanity-check the confirmed
-- amount against what we intended, and is a durable record of the deposit.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS deposit_amount_usd numeric(10,2);

-- Set when Valor's webhook confirms the deposit (response_code "00"). This is
-- the authoritative "booked / paid" flag — NOT the approve click. Once set, the
-- quote is paid and the booked page + receipt are legitimate.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS deposit_paid_at timestamptz;

-- Valor transaction id for the deposit. Also the idempotency key for the
-- webhook (Valor retries up to 3×) — we dedupe on it so the receipt + CRM move
-- fire at most once.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS valor_txn_id text;

-- Card-on-file / vault token returned at payment time. Stored so staff can pull
-- up the saved card in the Valor portal to MANUALLY charge the remaining 50%
-- balance after install. Treat as sensitive — it is a payment-profile reference
-- (not a PAN), but still record-keeping only, never re-exposed to the browser.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS valor_vault_token text;

-- Approval / auth code from the processor, for receipts and reconciliation.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS valor_approval_code text;

-- Valor's hosted receipt URL for the deposit, included in the customer's
-- confirmation email (#42).
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS valor_receipt_url text;

-- Full verified webhook payload, for debugging/reconciliation if a downstream
-- side effect (CRM move / receipt) fails after we recorded the payment.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS valor_payment_raw jsonb;

-- Webhook lookup path: "which quote does this confirmation belong to?"
CREATE INDEX IF NOT EXISTS quotes_valor_order_ref_idx
  ON public.quotes (valor_order_ref)
  WHERE valor_order_ref IS NOT NULL;

-- Idempotency / reconciliation: find a quote by its Valor transaction id.
CREATE INDEX IF NOT EXISTS quotes_valor_txn_id_idx
  ON public.quotes (valor_txn_id)
  WHERE valor_txn_id IS NOT NULL;

COMMIT;
