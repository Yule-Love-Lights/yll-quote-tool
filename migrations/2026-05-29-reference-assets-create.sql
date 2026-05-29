-- Reference assets — product close-up photos (spritzer / wreath / garland) that
-- get injected into Claude photo-analysis calls as "this is what X looks like"
-- few-shot context. Managed from the internal Training UI (/training/references).
--
-- WHY THIS FILE EXISTS:
--   This table was originally created by hand in the Supabase dashboard and was
--   never captured in a migration, so the database could not be rebuilt from the
--   repo (flagged in docs/CURRENT_STATE.md as a "works on the live DB only" risk).
--   This migration records its shape so the schema is reproducible. The columns
--   are derived from src/lib/referenceAssets.ts (the StoredReferenceAsset type +
--   the insert in saveReferenceAsset).
--
-- IDEMPOTENT + ROLL-FORWARD: safe to re-run. On the existing live DB (where the
--   table already exists) `create table if not exists` is a no-op; on a fresh DB
--   it builds the table. To change the table later, add a NEW migration — don't
--   edit this file after it has been applied.
--
-- HOW TO APPLY: paste this whole file into Supabase -> SQL Editor -> New query ->
--   Run. There is no automated migration runner on this project.

create table if not exists reference_assets (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamp with time zone default now(),
  asset_type  text not null,                 -- 'spritzer' | 'wreath' | 'garland'
  size        text not null,                 -- e.g. '24', '30noble', '9ft'
  tier        text,                          -- e.g. 'labor' | 'bow' | 'fullDecor' (nullable)
  base64      text not null,                 -- image bytes, base64-encoded (stored inline, not in Storage)
  media_type  text not null,                 -- e.g. 'image/png', 'image/jpeg'
  caption     text,                          -- optional human note (nullable)
  active      boolean not null default true, -- only active rows are fed to Claude
  -- Constrain asset_type to the values the app actually uses
  -- (matches the ReferenceAssetType union in referenceAssets.ts).
  constraint reference_assets_asset_type_check
    check (asset_type in ('spritzer', 'wreath', 'garland'))
);

-- Internal/admin table reached via the ANON Supabase client (getSupabaseClient),
-- so RLS is disabled — same posture as the sibling tables photo_corrections and
-- training_houses (see db/schema.sql). Do NOT switch this to the service-role
-- client / enable RLS without updating referenceAssets.ts to match.
alter table reference_assets disable row level security;

create index if not exists reference_assets_created_at_idx on reference_assets (created_at desc);
create index if not exists reference_assets_asset_type_idx on reference_assets (asset_type);
