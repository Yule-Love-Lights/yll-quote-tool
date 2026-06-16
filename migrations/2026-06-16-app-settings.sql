-- =====================================================================
-- app_settings — global editor/render settings (task #32, Phase 1).
-- Idempotent; safe to re-run. Paste into the Supabase SQL Editor and Run.
--
-- A simple key→JSON store for APP-WIDE settings (one config for the whole YLL
-- business), mirroring the design tool's `app_settings` table. Phase 1 keys:
--   'colors'   → BulbColor[]      (the editable palette)
--   'render'   → RenderSettings   (global render tunables, e.g. spritzerRayDensity)
--   'defaults' → ToolDefaults     (per-type seed defaults — reserved for Phase 2)
--
-- Reached only via the service-role client (server API routes), so RLS is
-- disabled to match `designs`/`quotes`.
-- =====================================================================

create table if not exists app_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table app_settings disable row level security;

-- Keep updated_at fresh on every write (mirrors the designs trigger).
create or replace function app_settings_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists app_settings_updated_at_trigger on app_settings;
create trigger app_settings_updated_at_trigger
  before update on app_settings
  for each row execute function app_settings_set_updated_at();
