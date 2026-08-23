-- Ledger #314 fix round (S46 premerge review, staff-lens HIGH): the approval-
-- time GHL Event Date reconcile originally compared the quote's date against
-- GHL's LIVE current value and overwrote on any mismatch — which reverts a
-- staff correction made directly in GHL (their real scheduling workflow) the
-- moment the customer approves. This column tracks the MM/DD/YYYY value we
-- last CONFIRMED pushed, so every push site (send-time, the builder's
-- date-changing save, and this approval reconcile) can compare "did OUR side
-- change since we last pushed" instead of "does GHL currently agree with us."
--
-- Nullable text, no default/backfill — legacy rows (approved or last pushed
-- before this column existed) read null, and the approve route treats null
-- conservatively: it only overwrites an EMPTY GHL value, never a non-empty
-- one, when there is no push history to compare against.
alter table public.quotes
  add column if not exists ghl_event_date_pushed text;

comment on column public.quotes.ghl_event_date_pushed is
  'MM/DD/YYYY value last CONFIRMED pushed to GHL''s "Event Date" custom field (ledger #314). Stamped by every push site (send route, quote/route.ts''s date-changing update, the approve route reconcile) on a successful push. Compared against the quote''s current formatted event date to detect "our side changed since the last push" — never compared against GHL''s live value, which would silently revert a staff correction made directly in GHL. Null = legacy/never-confirmed-pushed row.';
