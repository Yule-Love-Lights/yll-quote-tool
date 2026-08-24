-- The initial staff_notes migration granted service_role only SELECT/INSERT,
-- but this Supabase project's default table privileges had already supplied
-- UPDATE/DELETE/TRUNCATE. Revoke the inherited set explicitly so the table is
-- append-only through the application role, then grant back exactly what the
-- staff-notes route needs.

revoke all on public.staff_notes from service_role;
grant select, insert on public.staff_notes to service_role;
