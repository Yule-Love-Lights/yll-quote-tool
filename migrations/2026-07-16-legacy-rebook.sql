-- ─────────────────────────────────────────────────────────────────────────
-- Migration: add `legacy_rebook` to quotes (#155)
-- ─────────────────────────────────────────────────────────────────────────
-- Flags a quote migrated from last year's Jobber data (a legacy rebook) so
-- the customer portal and admin detail page can show a slightly different
-- experience for it. Every consumer must gate on this column as a POSITIVE
-- match (legacy_rebook = true), never a negative one, so normal quotes are
-- unaffected (AGENTS.md seam-gate rule).
--
-- - boolean NOT NULL DEFAULT false: every existing/new row is a normal quote
--   unless explicitly marked. Idempotent: ADD COLUMN IF NOT EXISTS, per
--   CONVENTIONS.md §6 (model: migrations/2026-06-28-quotes-add-is-test.sql).

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS legacy_rebook boolean NOT NULL DEFAULT false;
