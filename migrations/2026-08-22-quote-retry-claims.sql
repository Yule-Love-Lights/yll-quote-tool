-- Quote retry claims: prevent concurrent retryDelivery and retryGhl requests
-- from duplicating customer messages or HighLevel reconciliation work.
--
-- Each nullable timestamp is a short-lived lease. POST /api/quotes/[id]/send
-- claims it with a conditional UPDATE before invoking an external provider,
-- releases its exact claim after the attempt settles, and lets an abandoned
-- claim expire after the route's two-minute safety window. Separate columns
-- keep customer delivery and CRM reconciliation independently retryable.
--
-- Roll-forward only. Nullable operational metadata: no backfill, no index
-- needed because every claim targets quotes.id (the primary key).
BEGIN;

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS delivery_retry_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS ghl_retry_claimed_at timestamptz;

COMMIT;
