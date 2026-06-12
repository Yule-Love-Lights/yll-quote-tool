-- =====================================================================
-- #36 — Gemini/AI render pipeline TEARDOWN (2026-06-12)
--
-- Drops the `renders` table and everything attached to it. The portal
-- hero is the live Konva design now (task #27/#35); the Gemini render
-- code was removed from the app in the same PR that adds this file, so
-- nothing reads or writes any of these objects anymore.
--
-- HOW TO APPLY: paste into the Supabase SQL Editor and Run. Idempotent;
-- safe to re-run.
--
-- ⚠️ AFTER running this, delete the `renders` STORAGE BUCKET by hand in
-- the Supabase UI (Storage → renders → Delete bucket, including all
-- objects). Buckets are managed by the Storage API, not plain SQL —
-- deleting the rows out from under it is unreliable across Supabase
-- versions, so the UI is the supported path. All artifacts are test
-- data; nothing needs archiving.
-- =====================================================================

-- 1. The table. CASCADE takes the trigger, indexes, constraints, and the
--    table's RLS policies with it (dropping those individually first would
--    ERROR once the table is gone — table-first keeps this re-runnable).
drop table if exists renders cascade;

-- 2. The trigger's helper function (not table-owned, so dropped separately).
drop function if exists renders_set_updated_at();

-- 3. Storage-object policies for the renders bucket. These live on
--    storage.objects — independent of the table AND of the bucket row —
--    so they'd silently linger after the UI bucket-delete. Drop them here.
drop policy if exists "anon insert renders bucket" on storage.objects;
drop policy if exists "anon read renders bucket" on storage.objects;
drop policy if exists "anon update renders bucket" on storage.objects;
drop policy if exists "anon delete renders bucket" on storage.objects;
