-- Audit fix (g1-route / approve-toctou-and-notify-marker, merge of #43/#18/#83):
-- a durable staff signal for an approval whose notifications didn't go through.
--
-- All three approve-time notifications (customer SMS/email + the internal
-- "go collect the deposit" email) are best-effort. When GHL is unconfigured,
-- HIGHLEVEL_INTERNAL_CONTACT_ID is unset, or a send throws, the approval is
-- still recorded but staff get NO signal that a deposit call is owed — and the
-- ok:true response goes to the customer's browser, not staff. These two
-- nullable columns let the route stamp a durable "notify failed" marker so a
-- future dashboard queue (separate Naldo task) can surface the orphaned
-- approvals. Additive + nullable → non-breaking; idempotent.
--
-- Roll-forward only.
BEGIN;

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS approval_notify_failed_at timestamptz,
  ADD COLUMN IF NOT EXISTS approval_notify_error text;

-- Partial index for the future "approved but staff never notified" dashboard
-- bucket. Tiny — only rows where a notification failed.
CREATE INDEX IF NOT EXISTS quotes_approval_notify_failed_idx
  ON public.quotes (approval_notify_failed_at DESC)
  WHERE approval_notify_failed_at IS NOT NULL;

COMMIT;
