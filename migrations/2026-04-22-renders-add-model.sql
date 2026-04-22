-- Adds per-render model column so we can toggle between Gemini 3 Pro Image
-- ($0.20/call, photoreal) and Gemini 2.5 Flash Image ($0.04/call, draft).
-- Existing rows were all Pro renders, so default is 'pro'.
--
-- Paste into Supabase SQL Editor. Safe to re-run.

ALTER TABLE renders
  ADD COLUMN IF NOT EXISTS model text NOT NULL DEFAULT 'pro';

-- Optional: restrict to known values. If a third model ever lands, drop
-- this constraint, add the new value in code, then re-add with new values.
ALTER TABLE renders DROP CONSTRAINT IF EXISTS renders_model_check;
ALTER TABLE renders
  ADD CONSTRAINT renders_model_check CHECK (model IN ('pro', 'flash'));
