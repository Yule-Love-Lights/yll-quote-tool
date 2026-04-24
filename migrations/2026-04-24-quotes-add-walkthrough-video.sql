-- Walkthrough video columns on quotes. Lets Naldo attach a personal
-- video to each quote that plays on the customer portal right below
-- the hero photo. Shown on v1 (/portal), v2 (/portal-dark), and v6
-- (/portal-snowglobe) — all three versions read the same columns so
-- the experience is consistent whichever theme wins.
--
-- Two hosting modes so Naldo can use whichever is easiest today:
--   video_kind='youtube' → video_src is the 11-char YouTube video ID
--   video_kind='mp4'     → video_src is the full URL of a hosted .mp4
--                          (Supabase Storage, Cloudflare R2, any CDN)
--
-- All columns nullable — quotes without a video simply don't render
-- the walkthrough section. Safe to run on existing data.
--
-- Roll-forward only.

BEGIN;

-- Storage mode for this quote's walkthrough video. 'youtube' or 'mp4'.
-- NULL = no video attached yet (the walkthrough section hides entirely).
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS video_kind text
  CHECK (video_kind IS NULL OR video_kind IN ('youtube', 'mp4'));

-- The video itself. Interpretation depends on video_kind:
--   when 'youtube' → just the 11-char video ID, e.g. "dQw4w9WgXcQ"
--   when 'mp4'     → full public URL to the mp4 file
-- We deliberately store only the YouTube ID (not the full URL) so the
-- player component can build the privacy-enhanced embed URL without
-- re-parsing. Admin UI handles URL → ID extraction on save.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS video_src text;

-- Optional custom poster image. For YouTube we default to the auto
-- thumbnail if this is NULL; for MP4 we show a black poster.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS video_poster text;

-- Optional label shown above the player (defaults to "Your personal
-- walkthrough" in the UI if NULL).
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS video_title text;

-- Video duration in seconds. Rendered as "2:45" in the corner badge.
-- Optional — if NULL the badge just doesn't render.
ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS video_duration_sec integer;

COMMIT;
