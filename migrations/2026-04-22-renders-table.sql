-- Render engine Phase 1 — renders table + storage bucket.
-- Holds one row per generated render. Storage bucket 'renders' holds the
-- actual PNG files (source, composite, mask, final). The table references
-- them by storage_path.
--
-- Paste this into Supabase SQL Editor. Bucket creation at the bottom must
-- also be run (or create the bucket in the Supabase UI: Storage → New bucket
-- → name "renders", public read = off, RLS on).

CREATE TABLE IF NOT EXISTS renders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id uuid,                                    -- FK to quotes table if wired; nullable for now
  version int NOT NULL DEFAULT 1,                   -- re-renders increment this
  style text NOT NULL DEFAULT 'warm-white',         -- 'warm-white' | 'multi' | 'red-green'
  status text NOT NULL DEFAULT 'pending',           -- 'pending' | 'rendering' | 'ready' | 'approved' | 'rejected' | 'failed'
  photo_hash text NOT NULL,                         -- sha256 of source photo bytes
  vision_hash text NOT NULL,                        -- sha256 of stringified vision data
  cache_key text NOT NULL,                          -- hash(photo_hash + vision_hash + style) — same inputs never re-bill Gemini
  source_path text,                                 -- storage path for original daytime photo
  composite_path text,                              -- storage path for sharp composite (bulbs along polylines)
  mask_path text,                                   -- storage path for white-on-black mask PNG
  final_path text,                                  -- storage path for Gemini photoreal output
  ssim_score numeric,                               -- Phase 2: drift guard vs composite
  gemini_ms int,                                    -- latency in ms of the Gemini call
  gemini_cost_usd numeric,                          -- billed amount (estimate or reported)
  error_message text,                               -- populated when status = 'failed'
  approved_at timestamptz,
  approved_by text,
  rejected_reason text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS renders_quote_id_idx ON renders(quote_id);
CREATE INDEX IF NOT EXISTS renders_status_idx ON renders(status);
CREATE INDEX IF NOT EXISTS renders_cache_key_idx ON renders(cache_key);
CREATE INDEX IF NOT EXISTS renders_created_at_idx ON renders(created_at DESC);

-- Auto-update updated_at
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

-- Storage bucket — create via the Supabase UI OR run this once in SQL Editor:
-- (requires the storage extension; Supabase has it on by default)
INSERT INTO storage.buckets (id, name, public)
VALUES ('renders', 'renders', false)
ON CONFLICT (id) DO NOTHING;

-- RLS: allow anon read of approved renders only (for the customer proposal
-- page later); allow service role full access. Internal admin UI uses
-- service role on the server side.
ALTER TABLE renders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "anon can read approved renders" ON renders;
CREATE POLICY "anon can read approved renders" ON renders
  FOR SELECT USING (status = 'approved');

DROP POLICY IF EXISTS "service role full access" ON renders;
CREATE POLICY "service role full access" ON renders
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
