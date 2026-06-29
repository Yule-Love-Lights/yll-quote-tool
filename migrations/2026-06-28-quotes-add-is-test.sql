-- ─────────────────────────────────────────────────────────────────────────
-- Migration: add `is_test` to quotes (#93 Test Quote)
-- ─────────────────────────────────────────────────────────────────────────
-- Flags a quote (and, by the quote link, its derived job + invoice) as
-- fully-simulated test data: it flows the whole pipeline (send → portal
-- approve → simulate-deposit → job → inventory) but never fires a real GHL
-- text/email or Valor charge, is excluded from every dashboard metric +
-- the persisted customer list, is badged TEST in the admin/jobs/inventory
-- surfaces, and is one-click cleanable ("Delete test data").
--
-- - boolean NOT NULL DEFAULT false: every existing row is real (false); a
--   test quote is an explicit opt-in set at saveQuote() insert time. Never
--   mutated afterwards (updateQuote leaves it untouched) — so jobs/invoices
--   derive it by joining back to the quote with zero drift (no column on
--   jobs/invoices; the FK link is the single source of truth).
-- - Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS, per
--   CONVENTIONS.md §6 (model: migrations/2026-06-24-quotes-service-type.sql).
-- - Index: the dashboard/customer chokepoints filter `is_test = false` and
--   the cleanup deletes `is_test = true`, so the column is queried on every
--   metric read — index it.

-- 1. Add the column (idempotent).
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS is_test boolean NOT NULL DEFAULT false;

-- 2. Index for the is_test = false / true filters.
CREATE INDEX IF NOT EXISTS quotes_is_test_idx ON quotes (is_test);
