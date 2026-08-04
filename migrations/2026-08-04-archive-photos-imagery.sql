-- =====================================================================
-- archive_photos — slice 2 imagery columns + the training-archive bucket
-- (#167 P1 slice 2).
--
-- Slice 1 gave archive_photos satellite_ref / street_view_ref /
-- satellite_feet_per_pixel. Fetching the imagery exposed two gaps:
--
-- 1. WIDTH/HEIGHT. Every other satellite consumer in this repo stores the
--    same four things together — path, w, h, feet_per_pixel (designs
--    .satellite_path/_w/_h/_feet_per_pixel, and the same quartet on the
--    designs history table). feet_per_pixel alone does not locate a traced
--    line: the tracer needs the pixel dimensions of the image those lines
--    were drawn on. Without these, slice 3's pre-fill would hand the tracer
--    a scale with no canvas.
--
-- 2. A PLACE TO RECORD A FAILED FETCH. The batch runs against ~77 real
--    addresses over the Google APIs; some will miss (no geocode hit, no
--    Street View pano, a transient 5xx). Without a recorded error the batch
--    is not resumable — a failed row looks identical to an unfetched one and
--    silently retries forever, and nobody can see WHICH addresses need a
--    human. imagery_error holds the reason; imagery_fetched_at stamps the
--    success so "fetched" is a fact rather than an inference from a non-null
--    satellite_ref.
--
-- Slice 2 fills these per PROPERTY (grouped by resolved_address_key), then
-- moves that property's rows 'pending' -> 'ready_to_trace'.
--
-- NOTE on the status ladder: slice 1's header documents an intermediate
-- 'imagery_fetched' between 'pending' and 'ready_to_trace'. Slice 2 does NOT
-- use it — nothing happens between "imagery landed" and "a human can trace
-- this", so an intermediate state would only be a second value slice 3's queue
-- has to read for zero gain. A property goes straight to 'ready_to_trace' in
-- the same UPDATE that attaches its imagery. 'imagery_fetched' is now dead
-- vocabulary; left documented rather than rewritten so the ladder comment in
-- the slice-1 migration doesn't read as a contradiction.
--
-- HOW TO APPLY: paste into the Supabase SQL Editor and Run. Idempotent.
-- =====================================================================

alter table public.archive_photos
  add column if not exists satellite_w        integer,
  add column if not exists satellite_h        integer,
  add column if not exists imagery_error      text,
  add column if not exists imagery_fetched_at timestamptz;

-- The imagery worker claims work with
--   where status='pending' and satellite_ref is null and resolved_address is not null
-- and then groups by resolved_address_key. Index shaped to match: the partial
-- predicate is the cheap always-true-for-work part (satellite_ref is null), and
-- the leading columns are what the claim filters and groups on. The table is
-- 211 rows today, so this is about keeping the claim cheap as later manifest
-- drops land, not about today's performance.
create index if not exists archive_photos_imagery_pending_idx
  on public.archive_photos (status, resolved_address_key)
  where satellite_ref is null;

-- Private bucket for the fetched daytime imagery. Mirrors the 'designs'
-- bucket: private, service-role only, read back through a signed URL. The
-- epic spec's storage decision was bucket-first (path-referenced), never
-- base64 columns — googleMaps.ts hands back base64, so the worker uploads the
-- bytes here and stores only the path.
insert into storage.buckets (id, name, public)
values ('training-archive', 'training-archive', false)
on conflict (id) do nothing;
