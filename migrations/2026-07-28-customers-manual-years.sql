-- ─────────────────────────────────────────────────────────────────────────
-- Migration: add `manual_years` to customers (#178)
-- ─────────────────────────────────────────────────────────────────────────
-- Customer tenure ("years with YLL"): staff want to see, at a glance, how
-- many and which years a customer has worked with YLL. The full year set is
-- AUTO-DERIVED years (from quotes.deposit_paid_at, plus the #155 legacy_rebook
-- migration rows, which always mean 2025 regardless of the row's own dates —
-- see migrations/2026-07-16-legacy-rebook.sql) UNIONED with this column, a
-- staff-editable list for history this tool has no quote row for (e.g. a
-- season that predates the tool, or a cash job never invoiced here).
-- Derivation lives in src/lib/customerTenure.ts.
--
-- jsonb array of integer years (e.g. [2021, 2022]), not a relational table —
-- low cardinality, no query-by-year need. Validated + junk-filtered on READ
-- (customerTenure.ts) and validated on WRITE (POST /api/customers/[id]/
-- tenure-years) rather than a DB CHECK constraint, matching this table's
-- existing application-level validation style (see customerMatchKey etc.).
--
-- jsonb NOT NULL DEFAULT '[]': every existing/new row starts with no manual
-- override — tenure is pure auto-derivation until staff add one. Idempotent:
-- ADD COLUMN IF NOT EXISTS, per CONVENTIONS.md §6 (model: migrations/2026-07-
-- 16-legacy-rebook.sql). Applied out-of-band directly on prod; this file
-- documents it.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS manual_years jsonb NOT NULL DEFAULT '[]';
