-- ─────────────────────────────────────────────────────────────────────────
-- Migration: add `service_type` to quotes (#58 Phase 2a)
-- ─────────────────────────────────────────────────────────────────────────
-- Adds a categorization column so the dashboard can break results down by
-- Holiday / Permanent / Event service line (per docs/dashboard/VISION.md §4).
--
-- - text + CHECK rather than a true PG enum: extending an enum requires
--   ALTER TYPE which is annoying to roll back; text + CHECK lets us add
--   a new value with a simple ALTER and a new constraint.
-- - Nullable. The app reads NULL as 'holiday' (the legacy default) so
--   pre-existing rows don't need a backfill to render correctly — but
--   we backfill explicitly below anyway, so the data is canonical.
-- - Idempotent: ADD COLUMN IF NOT EXISTS + DROP CONSTRAINT IF EXISTS
--   before re-adding, per CONVENTIONS.md §6.

-- 1. Add the column (idempotent).
ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS service_type text;

-- 2. (Re-)add the CHECK constraint. Drop first so re-running this file
--    after editing the value set doesn't error.
ALTER TABLE quotes
  DROP CONSTRAINT IF EXISTS quotes_service_type_check;
ALTER TABLE quotes
  ADD CONSTRAINT quotes_service_type_check
  CHECK (service_type IS NULL OR service_type IN ('holiday', 'permanent', 'event'));

-- 3. Backfill existing rows (only ones that are still NULL — idempotent).
UPDATE quotes
  SET service_type = 'holiday'
  WHERE service_type IS NULL;

-- 4. Index for the dashboard per-service grouping.
CREATE INDEX IF NOT EXISTS quotes_service_type_idx ON quotes (service_type);
