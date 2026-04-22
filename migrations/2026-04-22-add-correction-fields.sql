-- Extend photo_corrections to store the full set of inputs the quote/new
-- page now captures. All columns are nullable so old rows remain valid and
-- the saveCorrection() insert still works if the client omits newer fields.
--
-- Run this in the Supabase SQL editor against the project used by
-- SUPABASE_URL. Safe to re-run (IF NOT EXISTS guards).

ALTER TABLE photo_corrections
  ADD COLUMN IF NOT EXISTS corrected_c9_lines jsonb,
  ADD COLUMN IF NOT EXISTS corrected_winter_wonderland_footage numeric,
  ADD COLUMN IF NOT EXISTS corrected_satellite_santas_lines jsonb,
  ADD COLUMN IF NOT EXISTS corrected_satellite_gingerbread_lines jsonb,
  ADD COLUMN IF NOT EXISTS corrected_satellite_c9_lines jsonb,
  ADD COLUMN IF NOT EXISTS corrected_wreath_detections jsonb,
  ADD COLUMN IF NOT EXISTS corrected_spritzer_detections jsonb,
  ADD COLUMN IF NOT EXISTS corrected_garland_detections jsonb;

-- Training houses now also persist garland bounding-box detections and the
-- c9 polyline used to calibrate winter wonderland footage, so few-shot
-- prompts can carry them forward instead of dropping them on save.
ALTER TABLE training_houses
  ADD COLUMN IF NOT EXISTS garland_detections jsonb,
  ADD COLUMN IF NOT EXISTS c9_lines jsonb;
