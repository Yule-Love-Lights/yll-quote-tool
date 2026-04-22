-- =====================================================================
-- AI QUOTE TOOL — full canonical schema. Idempotent; safe to re-run.
-- Paste this into Supabase SQL Editor and click Run. This replaces
-- running the individual dated migrations separately.
--
-- Covers:
--   1. renders table (+ indexes, trigger, bucket)
--   2. renders RLS — hardened policies (anon insert/update/read-approved)
--   3. renders storage bucket RLS (insert/update/delete; NO anon select)
--   4. photo_corrections extra columns (corrected_* jsonb)
--   5. training_houses extra columns (garland_detections, c9_lines)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. renders table
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS renders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid,
  version int NOT NULL DEFAULT 1,
  style text NOT NULL DEFAULT 'warm-white',
  model text NOT NULL DEFAULT 'pro',
  status text NOT NULL DEFAULT 'pending',
  photo_hash text NOT NULL,
  vision_hash text NOT NULL,
  cache_key text NOT NULL,
  source_path text,
  composite_path text,
  mask_path text,
  final_path text,
  ssim_score numeric,
  gemini_ms int,
  gemini_cost_usd numeric,
  error_message text,
  approved_at timestamptz,
  approved_by text,
  rejected_reason text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Existing deployments: add model column if missing; enforce allowed values.
ALTER TABLE renders ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT 'pro';
ALTER TABLE renders DROP CONSTRAINT IF EXISTS renders_model_check;
ALTER TABLE renders ADD CONSTRAINT renders_model_check CHECK (model IN ('pro', 'flash2', 'flash'));

CREATE INDEX IF NOT EXISTS renders_quote_id_idx ON renders(quote_id);
CREATE INDEX IF NOT EXISTS renders_status_idx ON renders(status);
CREATE INDEX IF NOT EXISTS renders_cache_key_idx ON renders(cache_key);
CREATE INDEX IF NOT EXISTS renders_created_at_idx ON renders(created_at DESC);

CREATE OR REPLACE FUNCTION renders_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS renders_updated_at_trigger ON renders;
CREATE TRIGGER renders_updated_at_trigger
  BEFORE UPDATE ON renders
  FOR EACH ROW EXECUTE FUNCTION renders_set_updated_at();

-- Storage bucket for render artifacts (source/composite/mask/final PNGs).
INSERT INTO storage.buckets (id, name, public)
VALUES ('renders', 'renders', false)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------
-- 2. renders RLS — hardened policies
-- ---------------------------------------------------------------------
ALTER TABLE renders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read approved renders" ON renders;
DROP POLICY IF EXISTS "anon full access renders" ON renders;
DROP POLICY IF EXISTS "service role full access" ON renders;
DROP POLICY IF EXISTS "anon read approved" ON renders;
DROP POLICY IF EXISTS "anon insert" ON renders;
DROP POLICY IF EXISTS "anon update unapproved" ON renders;

CREATE POLICY "anon read approved" ON renders
  FOR SELECT USING (status = 'approved');

CREATE POLICY "anon insert" ON renders
  FOR INSERT WITH CHECK (true);

CREATE POLICY "anon update unapproved" ON renders
  FOR UPDATE USING (status <> 'approved') WITH CHECK (true);

-- ---------------------------------------------------------------------
-- 3. renders storage bucket RLS
-- ---------------------------------------------------------------------
DROP POLICY IF EXISTS "anon insert renders bucket" ON storage.objects;
DROP POLICY IF EXISTS "anon read renders bucket" ON storage.objects;
DROP POLICY IF EXISTS "anon update renders bucket" ON storage.objects;
DROP POLICY IF EXISTS "anon delete renders bucket" ON storage.objects;

CREATE POLICY "anon insert renders bucket" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'renders');

CREATE POLICY "anon update renders bucket" ON storage.objects
  FOR UPDATE USING (bucket_id = 'renders') WITH CHECK (bucket_id = 'renders');

CREATE POLICY "anon delete renders bucket" ON storage.objects
  FOR DELETE USING (bucket_id = 'renders');

-- NOTE: no anon SELECT policy on the renders bucket. Signed URLs still
-- work — the internal signer uses a service-role-equivalent token baked
-- into the URL.

-- ---------------------------------------------------------------------
-- 4. photo_corrections extra columns
-- ---------------------------------------------------------------------
ALTER TABLE photo_corrections
  ADD COLUMN IF NOT EXISTS corrected_c9_lines jsonb,
  ADD COLUMN IF NOT EXISTS corrected_winter_wonderland_footage numeric,
  ADD COLUMN IF NOT EXISTS corrected_satellite_santas_lines jsonb,
  ADD COLUMN IF NOT EXISTS corrected_satellite_gingerbread_lines jsonb,
  ADD COLUMN IF NOT EXISTS corrected_satellite_c9_lines jsonb,
  ADD COLUMN IF NOT EXISTS corrected_wreath_detections jsonb,
  ADD COLUMN IF NOT EXISTS corrected_spritzer_detections jsonb,
  ADD COLUMN IF NOT EXISTS corrected_garland_detections jsonb;

-- ---------------------------------------------------------------------
-- 5. training_houses extra columns
-- ---------------------------------------------------------------------
ALTER TABLE training_houses
  ADD COLUMN IF NOT EXISTS garland_detections jsonb,
  ADD COLUMN IF NOT EXISTS c9_lines jsonb;
