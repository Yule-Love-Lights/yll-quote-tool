-- HARDENING: the 2026-04-22-renders-fix-rls.sql migration was too permissive.
-- It granted anon SELECT on renders (exposing failed rows + error messages +
-- cost data) AND on the storage bucket (making every customer photo guessable
-- by {uuid}/source.jpg once the row ID leaks). See REVIEW-2026-04-22.md C1+C2.
--
-- This migration replaces those policies with:
--   * renders table: anon can INSERT/UPDATE; SELECT only when status='approved'
--     (so Phase 5 customer URL still works). No anon DELETE.
--   * storage bucket: anon can INSERT/UPDATE/DELETE (the app writes with the
--     anon key), but NOT SELECT. Signed URLs still resolve — supabase signs
--     them server-side with a service-role-equivalent token baked into the URL.
--
-- Paste into Supabase SQL Editor → New Query → Run. Safe to re-run; all
-- drops are IF EXISTS.

-- === renders table policies ===
DROP POLICY IF EXISTS "anon full access renders" ON renders;
DROP POLICY IF EXISTS "anon can read approved renders" ON renders;
DROP POLICY IF EXISTS "service role full access" ON renders;

-- Customer-visible: approved renders only. Phase 5 proposal URL will read
-- through the anon key and needs approved rows to come back.
CREATE POLICY "anon read approved" ON renders
  FOR SELECT USING (status = 'approved');

-- App writes with the anon key (like photo_corrections / training_houses).
-- Restrict UPDATE to not-yet-approved rows so a hijacker can't silently
-- un-approve or rewrite an approved render after the fact.
CREATE POLICY "anon insert" ON renders
  FOR INSERT WITH CHECK (true);

CREATE POLICY "anon update unapproved" ON renders
  FOR UPDATE USING (status <> 'approved') WITH CHECK (true);

-- No anon DELETE policy. Admin UI goes through /api/renders/[id] DELETE,
-- which now requires x-admin-secret and uses the anon client — so deletes
-- will fail at the DB layer unless a service-role key is supplied. This is
-- intentional until admin endpoints move to a service-role client.

-- === storage bucket policies ===
DROP POLICY IF EXISTS "anon insert renders bucket" ON storage.objects;
DROP POLICY IF EXISTS "anon read renders bucket" ON storage.objects;
DROP POLICY IF EXISTS "anon update renders bucket" ON storage.objects;
DROP POLICY IF EXISTS "anon delete renders bucket" ON storage.objects;

-- App uploads via anon — keep INSERT + UPDATE (upsert: true uses both).
CREATE POLICY "anon insert renders bucket" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'renders');

CREATE POLICY "anon update renders bucket" ON storage.objects
  FOR UPDATE USING (bucket_id = 'renders') WITH CHECK (bucket_id = 'renders');

-- Admin delete flow goes through /api/renders/[id] DELETE. Allowing anon
-- DELETE here matches the existing shape — route-level auth (x-admin-secret)
-- is the real gate.
CREATE POLICY "anon delete renders bucket" ON storage.objects
  FOR DELETE USING (bucket_id = 'renders');

-- NO anon SELECT policy on renders bucket — customer photos stay private.
-- Signed URLs continue to work via supabase's internal signer.
