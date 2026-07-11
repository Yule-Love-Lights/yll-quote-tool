-- Referral program, PR 1 (ledger #41). Locked product (Naldo, S30): the
-- referrer earns $125 next-season credit per booked friend, stackable (one row
-- per friend, no cap). The friend gets two free 16" spritzers on their first
-- booked install — that redemption UI is PR 2; this migration only lays down
-- the data PR 2 will read.
--
-- Attribution is BOTH ways:
--   'link'    — the referrer's personal /refer/<code> link (referee_quote_id
--               is NULL at creation — the landing-page submit is a lead
--               capture, before any quote exists for that lead).
--   'mention' — staff picks an existing customer as "Referred by" while
--               building a NEW quote (src/components/quote/QuoteBuilder.tsx);
--               referee_quote_id is the quote being created, known immediately.
--
-- accrueOnBooking (src/lib/referrals.ts) flips a PENDING row to 'booked' when
-- its referee_quote_id's deposit is paid — it matches ONLY on referee_quote_id,
-- so a 'link' row (still NULL) never auto-accrues on its own; staff confirming
-- the same referrer via the builder's "Referred by" picker once a real quote
-- exists for that lead is what creates the 'mention' row that actually accrues.
-- That's intentional for PR 1 — no double-credit path, and no quote-less row
-- can ever reach 'booked'.
--
-- UNIQUE(referee_quote_id) is the once-per-referee idempotency backstop: a
-- given booked friend can only ever credit ONE referrer, and accrueOnBooking's
-- conditional UPDATE (.eq('status','pending')) can only ever flip it once.
-- NULLs don't collide under Postgres unique semantics, so any number of
-- pending 'link' rows (referee_quote_id still NULL) coexist safely.
--
-- Idempotent; safe to re-run. HOW TO APPLY: paste into the Supabase SQL Editor
-- and Run — the seat applies this to prod before merge (not applied by this
-- change).
create table if not exists public.referrals (
  id                    uuid primary key default gen_random_uuid(),
  referrer_customer_id  uuid references public.customers(id) on delete set null,
  referee_quote_id      uuid references public.quotes(id) on delete set null,
  referee_contact_name  text,
  referee_contact_email text,
  referee_contact_phone text,
  source                text not null,
  status                text not null default 'pending',
  amount_usd            numeric not null default 125,
  booked_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table public.referrals drop constraint if exists referrals_source_check;
alter table public.referrals add constraint referrals_source_check
  check (source in ('link', 'mention'));

alter table public.referrals drop constraint if exists referrals_status_check;
alter table public.referrals add constraint referrals_status_check
  check (status in ('pending', 'booked', 'credited'));

-- The once-per-referee idempotency backstop (see header).
alter table public.referrals drop constraint if exists referrals_referee_quote_id_key;
alter table public.referrals add constraint referrals_referee_quote_id_key unique (referee_quote_id);

create index if not exists referrals_referrer_customer_id_idx
  on public.referrals (referrer_customer_id);

-- Defense in depth (mirrors the #90 all-tables hardening): reached only via the
-- service-role client (BYPASSRLS), so RLS with ZERO policies denies anon/
-- authenticated entirely while every server path keeps working unchanged.
alter table public.referrals enable row level security;

create or replace function public.referrals_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists referrals_updated_at_trigger on public.referrals;
create trigger referrals_updated_at_trigger
  before update on public.referrals
  for each row execute function public.referrals_set_updated_at();

-- ── Customer-facing referral identity ──────────────────────────────────────
-- referral_code: the short URL-safe code behind /refer/<code> (ensureReferralCode
-- create-if-missing, race-safe via this UNIQUE index). Null until a customer's
-- code is first ensured (the booked-page referral section, or the GHL stamp).
alter table public.customers
  add column if not exists referral_code text unique;

-- referral_photo_optout: when true, the /refer/<code> landing page skips using
-- this customer's own house photo as the hero (falls back to a generic
-- completed-work gallery photo instead). Defaults false (opt-out, not opt-in) —
-- most customers are proud to show off the install; staff/customer can flip it.
alter table public.customers
  add column if not exists referral_photo_optout boolean not null default false;
