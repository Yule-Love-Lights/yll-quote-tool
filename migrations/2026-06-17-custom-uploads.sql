-- =====================================================================
-- custom_uploads — custom graphic library (task #32, Phase 3).
-- Idempotent; safe to re-run. Paste into the Supabase SQL Editor and Run.
--
-- Staff-uploaded item graphics ("custom" items) that can be placed on ANY
-- design (a global library, not per-design). The image bytes live in the PUBLIC
-- `custom-uploads` Storage bucket; this table is the library index (so we keep
-- the original filename + a stable id for the UI). A placed custom scene item
-- stores `imagePath` = the object path; the editor + portal render it via the
-- /photos/<path> route, which redirects to the public object URL.
--
-- Public bucket (Jason, S9): these decorative graphics are shown to customers on
-- the portal anyway, so they're non-sensitive — public URLs avoid signed-URL
-- expiry. Writes go through the service-role client; the table itself is
-- service-role-only (RLS disabled, matching designs/app_settings).
-- =====================================================================

create table if not exists custom_uploads (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  path text not null,                                  -- object path in the custom-uploads bucket
  created_at timestamptz not null default now()
);

alter table custom_uploads disable row level security;

create index if not exists custom_uploads_created_at_idx on custom_uploads (created_at desc);

-- Public bucket for the custom-item graphics (anonymous read is automatic for
-- public buckets; uploads/deletes go through the service-role client).
insert into storage.buckets (id, name, public)
values ('custom-uploads', 'custom-uploads', true)
on conflict (id) do nothing;
