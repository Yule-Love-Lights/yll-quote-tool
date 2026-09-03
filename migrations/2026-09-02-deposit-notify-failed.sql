-- Incident fix (2026-09-02): the deposit-received webhook's "✅ deposit
-- received" staff alert is a single GHL email to one internal contact
-- (HIGHLEVEL_INTERNAL_CONTACT_ID, the sales@ inbox). On 2026-08-31 that
-- contact got Email DND switched on in GHL, so GHL rejected every send to it
-- — the route's only reaction was a console.warn. Two real deposits (2026-09-01,
-- 2026-09-02) produced no staff alert and nobody noticed for two days, while
-- the customer's own SMS + email in the same batch went out fine.
--
-- These two nullable columns are a durable staff-visible marker for that
-- failure, mirroring quotes.approval_notify_failed_at / approval_notify_error
-- (the approve route's sibling marker, migrations/2026-06-27-quotes-add-
-- approval-notify-marker.sql) — see internalEmail() in
-- src/app/api/integrations/valor/webhook/route.ts. Additive + nullable →
-- non-breaking; idempotent.
--
-- Roll-forward only.
BEGIN;

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS deposit_notify_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS deposit_notify_error text;

-- Partial index for a future "booked but staff never notified" dashboard
-- bucket — mirrors quotes_approval_notify_failed_idx. Tiny — only rows where
-- the notification failed.
CREATE INDEX IF NOT EXISTS quotes_deposit_notify_failed_idx
  ON public.quotes (deposit_notify_failed_at DESC)
  WHERE deposit_notify_failed_at IS NOT NULL;

COMMIT;
