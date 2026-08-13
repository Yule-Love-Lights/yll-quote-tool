-- =====================================================================
-- quote_deliveries — durable record of every attempt to deliver a quote
-- (SMS or email, via GHL Conversations) to a CUSTOMER (#250).
--
-- THE GAP THIS CLOSES: sendSms/sendEmail (src/lib/integrations/highlevel.ts)
-- are bare GHL POSTs with no DB write before or after; the outcome
-- (smsSent/emailSent/smsError/emailError) previously lived only in the HTTP
-- response body of POST /api/quotes/[id]/send — gone the moment the response
-- returned. #241 (a re-send silently delivering nothing while reporting
-- success) was only diagnosable because the code path happens to be
-- deterministic given the row's state, not because anything recorded what
-- actually happened. This table is the record.
--
-- TABLE vs COLUMNS ON quotes: a quote can be sent, re-delivered
-- (?retryDelivery=1), and retried per channel (SMS-only / email-only via the
-- {channel} body param) — an unbounded number of attempts per quote, each
-- with its own outcome. Columns on `quotes` can only ever hold the LATEST
-- attempt per channel, silently overwriting the history that #241 needed. A
-- one-row-per-attempt child table (matches the quote_view_events /
-- self_serve_estimates precedent) is the only shape that answers "did
-- customer X ever actually receive their quote, and when" for every attempt,
-- not just the most recent one.
--
-- SCOPE: this table logs delivery of THE QUOTE itself — the portal-link
-- SMS/email sent from POST /api/quotes/[id]/send (both a fresh send and a
-- ?retryDelivery=1 re-delivery use the exact same customerSms/customerEmail
-- closures in that route, so both paths write here). Every OTHER
-- sendSms/sendEmail caller in the codebase sends a different customer
-- message (approval confirmation, decline/changes-requested staff alert,
-- balance-due link, amendment notice, payment receipt, referral payout,
-- inbox reply, internal ops alerts) — deliberately out of this table's scope;
-- see the #250 PR description for the full call-site census.
--
-- Written best-effort from the send route: a logging failure must never
-- break the actual customer send (see logQuoteDelivery in
-- src/lib/quoteDeliveries.ts, which never throws).
--
-- RLS ENABLED, ZERO POLICIES — matches the quote_view_events / self_serve_
-- estimates convention: only the service-role client (send route) ever
-- touches this table, so RLS with no policies denies anon/authenticated
-- entirely while the real path is unchanged.
-- =====================================================================

create table if not exists public.quote_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  quote_id            uuid not null references public.quotes(id) on delete cascade,
  -- 'sms' | 'email'
  channel             text not null check (channel in ('sms', 'email')),
  -- 'sent' | 'failed' — the send attempt's outcome, not the quote's lifecycle.
  outcome             text not null check (outcome in ('sent', 'failed')),
  -- GHL's conversations/messages response id, when the send succeeded and GHL
  -- returned one. Null on failure or when GHL didn't hand one back.
  provider_message_id text,
  -- The send error, when outcome = 'failed'. Null on success.
  error               text
);

-- "Did customer X receive their quote, and when" — per-quote history,
-- newest-first.
create index if not exists quote_deliveries_quote_id_idx
  on public.quote_deliveries (quote_id, created_at desc);

-- Ops sweep across all quotes (e.g. "list failed deliveries today").
create index if not exists quote_deliveries_created_at_idx
  on public.quote_deliveries (created_at desc);

alter table public.quote_deliveries enable row level security;
