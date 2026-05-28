-- Adds per-package render variants so the customer portal can show a
-- distinct preview image per line item (Santa's Roofline, Gingerbread
-- Ridge, Mini Lights, Wreaths, Spritzers, Garland) PLUS the full package.
--
-- Why a column on `renders` instead of a sibling table:
--   - All existing artifact / approval / cost / cache plumbing already
--     hangs off the renders row. Splitting variants out would mean
--     duplicating uploadArtifact, getSignedUrl, approveRender, etc.
--   - Each variant is fully independent — different vision input, different
--     cache key, different artifact set. They're "renders," not children
--     of a render.
--
-- Unique index on (quote_id, variant, style):
--   - Prevents duplicate variant rows for the same quote stacking up
--     across re-renders. New render of an existing variant should REPLACE
--     the old one, not coexist with it.
--   - Partial WHERE clause skips quote_id IS NULL rows (smoke-test renders
--     done from /admin/renders/new without a quoteId attached).
--
-- Backfill: existing rows get variant='full' (their previous semantic).
--
-- Paste into Supabase SQL Editor. Safe to re-run.

ALTER TABLE renders
  ADD COLUMN IF NOT EXISTS variant text NOT NULL DEFAULT 'full';

ALTER TABLE renders DROP CONSTRAINT IF EXISTS renders_variant_check;
ALTER TABLE renders
  ADD CONSTRAINT renders_variant_check
  CHECK (variant IN ('full', 'santas', 'ridge', 'minis', 'wreaths', 'spritzers', 'garland'));

-- One non-rejected row per (quote, variant, style). Re-running a variant
-- replaces in the orchestrator (delete-then-insert handled in app code).
-- We exclude rejected/failed rows so a bad attempt doesn't permanently
-- block a fresh re-render.
CREATE UNIQUE INDEX IF NOT EXISTS renders_quote_variant_style_uniq
  ON renders (quote_id, variant, style)
  WHERE quote_id IS NOT NULL AND status NOT IN ('rejected', 'failed');

-- Lookup index for portal: "give me all approved variants for this quote."
-- Used on every customer portal page load.
CREATE INDEX IF NOT EXISTS renders_quote_status_variant_idx
  ON renders (quote_id, status, variant)
  WHERE quote_id IS NOT NULL;
