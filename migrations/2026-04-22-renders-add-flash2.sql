-- Adds 'flash2' to the renders.model CHECK constraint so we can route
-- renders to gemini-3.1-flash-image-preview (Nano Banana 2, ~$0.067/call).
-- Middle tier between flash (2.5, ~$0.04) and pro (3, ~$0.134).
--
-- Paste into Supabase SQL Editor. Safe to re-run.

ALTER TABLE renders DROP CONSTRAINT IF EXISTS renders_model_check;
ALTER TABLE renders
  ADD CONSTRAINT renders_model_check CHECK (model IN ('pro', 'flash2', 'flash'));
