-- ─────────────────────────────────────────────────────────────────────────
-- Migration: add `permanent_bistro` to the quotes.service_type CHECK (#117)
-- ─────────────────────────────────────────────────────────────────────────
-- Widens the service_type constraint (added 2026-06-24, extended for `event`
-- the same day) to allow the 4th service line — Permanent Bistro Lighting
-- (long-term café string lights, priced per linear ft + per pole; see
-- src/lib/permanentBistro/{types,pricing,packages}.ts).
--
-- - Idempotent: DROP CONSTRAINT IF EXISTS before re-adding, per
--   CONVENTIONS.md §6.
-- - No backfill needed: this only WIDENS the allowed value set — no existing
--   row can already hold 'permanent_bistro', and NULL still reads as
--   'holiday' per the original migration.

ALTER TABLE quotes
  DROP CONSTRAINT IF EXISTS quotes_service_type_check;
ALTER TABLE quotes
  ADD CONSTRAINT quotes_service_type_check
  CHECK (service_type IS NULL OR service_type IN ('holiday', 'permanent', 'event', 'permanent_bistro'));
