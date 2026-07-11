-- Referral program, PR 2 (ledger #41 redemption). PR 1's migration
-- (2026-07-10-referrals.sql) laid down the `referrals` table with a
-- 'pending' -> 'booked' -> 'credited' status lifecycle, but never gave
-- 'credited' anywhere to point. This adds the two columns consumeCredits
-- (src/lib/referrals.ts) stamps when a referrer's balance is SPENT as a
-- discount on a quote:
--
--   credited_at       — when the row was spent.
--   credited_quote_id — which quote spent it (the REFEREE... no, the
--                       REFERRER's own quote that the credit was applied
--                       to — NOT the friend's quote that earned it). A
--                       row's own `referee_quote_id` (PR 1) always stays
--                       the friend's quote that earned this $125; this new
--                       column records the separate, later quote (usually
--                       the referrer's own next season's order) the credit
--                       was spent against. The two can be different quotes,
--                       different customers even (staff applies credit for
--                       whoever is booking today) — that's why they're two
--                       columns, not one.
--
-- Idempotent; safe to re-run. HOW TO APPLY: paste into the Supabase SQL
-- Editor and Run — the seat applies this to prod before merge (not applied
-- by this change).

alter table public.referrals
  add column if not exists credited_at timestamptz;

alter table public.referrals
  add column if not exists credited_quote_id uuid references public.quotes(id) on delete set null;

-- Support looking up "what did this quote spend its credit on" (used nowhere
-- yet, but cheap and mirrors the referrer_customer_id index from PR 1).
create index if not exists referrals_credited_quote_id_idx
  on public.referrals (credited_quote_id);
