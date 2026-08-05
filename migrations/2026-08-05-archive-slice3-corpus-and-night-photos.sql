-- =====================================================================
-- #167 P1 slice 3 — corpus isolation + night-photo storage.
--
-- Two columns, for two different reasons.
--
-- 1. training_houses.source — CORPUS SAFETY, not just filterability.
--
--    The slice-3 plan says promoting archive traces into training_houses
--    needs "no change to inference code" because the existing few-shot
--    retrieval picks them up automatically. That is exactly the hazard.
--    getSimilarTrainingHouses builds its exemplar pool as
--      select id, house_style, created_at order by created_at desc limit poolSize
--    with no source filter, and analyzePhoto feeds the winners to the model
--    under "GROUND TRUTH from real installs — highest trust. Match their
--    precision and coordinate style."
--
--    Archive examples are traced on an OVERHEAD SATELLITE. Live customer
--    analysis runs on GROUND-LEVEL front-elevation photos. Promoting ~80
--    archive properties unfiltered would (a) hand the model overhead
--    geometry to imitate on a ground-level photo, and (b) land 80 rows at
--    once at the top of a recency-ordered pool, crowding out the hand-made
--    ground-level examples that pool exists to serve.
--
--    Same principle slice 2 already enforced when it refused to image an
--    imprecise geocode: bad training data is worse than missing training
--    data, and it is permanent in the corpus few-shot retrieval reads from.
--
--    Existing rows are all hand-made ground-level traces, so the backfill
--    default is 'manual' and the retrieval filter is POSITIVE
--    (source = 'manual', never source != 'archive') — per the seam-gate
--    pitfall, a negative gate silently hands every FUTURE source
--    ('partner', 'satellite', whatever lands next) the ground-photo
--    retrieval it was never vetted for.
--
-- 2. archive_photos.night_photo_ref — the queue has nothing to SHOW.
--
--    Slice 1 stored only drive_file_id. The app has no Drive credential
--    (GOOGLE_MAPS_API_KEY and a Gmail-scoped OAuth token are the only
--    Google creds that exist), and nothing in src/ reads drive_file_id
--    today. So the queue UI cannot render the archive night photo, and the
--    needs-identification lane — where a human looks at the photo to work
--    out WHICH house it is — is useless without it.
--
--    Decision (Naldo, 2026-08-05): one-time copy into the existing
--    training-archive bucket rather than granting the app Drive read. Keeps
--    the app credential-free, survives files moving in Drive, and matches
--    how the satellites are already stored. scripts/backfill-archive-night-
--    photos.ts does the copy; this column holds the resulting bucket path.
--
--    Keyed per PHOTO, not per property: the grain of archive_photos is one
--    row per Drive file, and the two rows that most need this column have
--    NO address at all (empty resolved_address_key), so the per-property
--    archiveStoragePrefix cannot key them. The script writes
--    night/<drive_file_id>.jpg — unique, never null, address-independent.
--
-- HOW TO APPLY: paste into the Supabase SQL Editor and Run. Idempotent.
--
-- ORDER: MIGRATION FIRST. Both columns are read by slice-3 code the moment
-- it is live — the retrieval SELECTs source, and the queue endpoint SELECTs
-- night_photo_ref — so the column must exist before the code that reads it.
-- =====================================================================

-- Backfills every existing row to 'manual', which is correct: everything in
-- the table today is a hand-made ground-level trace.
alter table public.training_houses
  add column if not exists source text not null default 'manual';

-- The exemplar pool orders by created_at desc and then filters to
-- source='manual'. Without this index that filter is applied after the scan;
-- with ~80 archive rows about to land at the top of the recency order, the
-- ground-photo pool would page through them on every analysis. Small table,
-- so this is about keeping the hot inference path cheap as the archive lands.
create index if not exists training_houses_source_created_idx
  on public.training_houses (source, created_at desc);

alter table public.archive_photos
  add column if not exists night_photo_ref text;
