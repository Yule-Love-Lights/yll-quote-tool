-- FIX: the previous migration locked the renders table + bucket behind
-- service_role-only policies, but the app writes with the anon key (same
-- as training_houses / photo_corrections). Relax to permissive policies
-- so anon can insert/update/delete, matching existing table behavior.
--
-- Paste into Supabase SQL Editor → New Query → Run.

-- === Table policies ===
DROP POLICY IF EXISTS "anon can read approved renders" ON renders;
DROP POLICY IF EXISTS "service role full access" ON renders;

-- Permissive: app uses anon key for all CRUD. Internal-tool so this is fine.
CREATE POLICY "anon full access renders" ON renders
  FOR ALL USING (true) WITH CHECK (true);

-- === Storage bucket policies ===
-- Storage uses its own policy table (storage.objects). Same idea — allow
-- the anon role to upload/read/delete objects in the 'renders' bucket.

DROP POLICY IF EXISTS "anon insert renders bucket" ON storage.objects;
DROP POLICY IF EXISTS "anon read renders bucket" ON storage.objects;
DROP POLICY IF EXISTS "anon update renders bucket" ON storage.objects;
DROP POLICY IF EXISTS "anon delete renders bucket" ON storage.objects;

CREATE POLICY "anon insert renders bucket" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'renders');

CREATE POLICY "anon read renders bucket" ON storage.objects
  FOR SELECT USING (bucket_id = 'renders');

CREATE POLICY "anon update renders bucket" ON storage.objects
  FOR UPDATE USING (bucket_id = 'renders') WITH CHECK (bucket_id = 'renders');

CREATE POLICY "anon delete renders bucket" ON storage.objects
  FOR DELETE USING (bucket_id = 'renders');
