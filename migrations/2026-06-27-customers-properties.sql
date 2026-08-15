-- Customer + Property identity (ledger #83, Phase 5).
--
-- Promotes customers from the loose, per-quote matching the dashboard does on
-- the fly (HL contact → email → phone → name; src/lib/dashboard/metrics.ts
-- customerKey) to a STABLE `customers` object with one-or-more `properties`
-- (home + rental + relative's). Quotes (and later jobs/invoices) reference both.
-- This is what powers "rebook last season" — a stable customer/property to clone
-- last season's approved quote + design from. See docs/jobber-flow/SPEC.md §4.5
-- and PLAN.md Phase 5.
--
-- ⚠️ MUST BE APPLIED TO THE LIVE SUPABASE BEFORE THE DEPENDENT CODE MERGES.
-- prod auto-deploys `master`; once src/lib/customers.ts / rebook.ts read or
-- write these tables/columns, a DB without them errors the query. Same handling
-- as every prior additive column (e.g. 2026-04-23-quotes-add-integration-
-- columns.sql, 2026-06-27-quotes-add-ghl-stage-sync.sql).
--
-- Additive + idempotent (create table if not exists / add column if not exists).
-- Roll-forward only — to remove later, write a new DROP migration rather than
-- editing this file. NO data backfill here: the customers/properties rows are
-- populated in code (src/lib/customers.ts backfillCustomersFromQuotes), which
-- reuses the exact dedup precedence and is idempotent + unit-tested.
BEGIN;

-- ── Customers ───────────────────────────────────────────────────────────────
-- A stable customer identity. `match_key` is the computed dedup key
-- (hl:<id> | email:<lower> | phone:<digits> | name:<lower>) — UNIQUE so
-- find-or-create is race-safe (the code select-then-inserts and falls back to a
-- re-select on the unique-violation race). hl_contact_id/name/email/phone are
-- the representative contact fields chosen across the matched quotes.
-- #213 (S34 #198 review): a candidate identity match that doesn't clear the
-- adoption bar (see src/lib/customers.ts classifyCandidate) creates a NEW row
-- instead of adopting — that row's match_key is instead a disambiguation key
-- shaped `dup:[["label","value"],...]` (JSON-encoded field pairs, e.g.
-- `dup:[["phone","5551234567"],["name","bob"]]`), never a plain hl:/email:/
-- phone:/name: key. Still UNIQUE, still race-safe; just not one of the four
-- "real" precedence-ranked shapes above.
CREATE TABLE IF NOT EXISTS public.customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_key     text UNIQUE,
  hl_contact_id text,
  name          text,
  email         text,
  phone         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Properties ──────────────────────────────────────────────────────────────
-- One-or-more service addresses per customer. `address_key` is the normalized
-- address (lowercased, punctuation stripped, whitespace collapsed) so trivial
-- formatting differences collapse to ONE property; UNIQUE per customer.
-- lat/lng are reserved for a future geocode (quotes carry no geo today) — left
-- NULL for now.
CREATE TABLE IF NOT EXISTS public.properties (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  address      text,
  address_key  text NOT NULL,
  lat          double precision,
  lng          double precision,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, address_key)
);

-- ── Quote linkage ───────────────────────────────────────────────────────────
-- Quotes reference the stable customer + property. Nullable: a quote with no
-- identity at all (anonymous test entry) stays unlinked. ON DELETE SET NULL so
-- removing a customer/property never cascade-deletes the quote history.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers(id) ON DELETE SET NULL;
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS property_id uuid REFERENCES public.properties(id) ON DELETE SET NULL;

-- Reached only via the service-role client (server routes), like quotes/designs.
ALTER TABLE public.customers  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.properties DISABLE ROW LEVEL SECURITY;

-- ── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS customers_hl_contact_id_idx
  ON public.customers (hl_contact_id) WHERE hl_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS customers_email_idx
  ON public.customers (email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS properties_customer_id_idx
  ON public.properties (customer_id);
CREATE INDEX IF NOT EXISTS quotes_customer_id_idx
  ON public.quotes (customer_id) WHERE customer_id IS NOT NULL;

-- ── updated_at triggers (mirror designs_set_updated_at) ─────────────────────
CREATE OR REPLACE FUNCTION public.customers_set_updated_at()
RETURNS trigger AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS customers_updated_at_trigger ON public.customers;
CREATE TRIGGER customers_updated_at_trigger
  BEFORE UPDATE ON public.customers
  FOR EACH ROW EXECUTE FUNCTION public.customers_set_updated_at();

DROP TRIGGER IF EXISTS properties_updated_at_trigger ON public.properties;
CREATE TRIGGER properties_updated_at_trigger
  BEFORE UPDATE ON public.properties
  FOR EACH ROW EXECUTE FUNCTION public.customers_set_updated_at();

COMMIT;
