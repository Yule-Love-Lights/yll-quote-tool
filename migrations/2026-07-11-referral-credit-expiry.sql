-- Referral credit expiry (ledger #41 follow-up). Locked product (Naldo): a
-- referral credit expires 2 years after it's EARNED (booked), not from row
-- creation. accrueOnBooking (src/lib/referrals.ts) stamps expires_at =
-- booked_at + 2 years in the SAME update that flips a row pending -> booked.
--
-- Backfill: existing 'booked' rows (booked before this column existed) get
-- expires_at = NULL. NULL is treated as non-expiring (grandfathered) by the
-- spendable check (status = 'booked' AND (expires_at IS NULL OR expires_at >
-- now())) that creditBalanceFor applies — that's intentional and safe: nobody
-- who already earned a credit has it silently expire the moment this column
-- is added. A 'booked' row whose expires_at HAS passed stays status='booked'
-- forever (we never rewrite history to 'expired') — it's just excluded from
-- the spendable balance and surfaced as a distinct display status.
--
-- Idempotent; safe to re-run. HOW TO APPLY: paste into the Supabase SQL Editor
-- and Run — the seat applies this to prod before merge (not applied by this
-- change).

alter table public.referrals
  add column if not exists expires_at timestamptz;
