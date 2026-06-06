-- =====================================================================
-- designs — design-tool integration (Path B), task #27 Phase 1.
-- Idempotent; safe to re-run. Paste into the Supabase SQL Editor and Run.
--
-- One editable on-photo light design (the "scene" = the design tool's Scene
-- JSON: yardsticks + items + brightness). A design is an INDEPENDENT record
-- with its own id and an OPTIONAL link to a quote, so it can exist before a
-- quote is saved (the builder creates it when the Street View photo is pulled)
-- and even with no quote at all (future standalone use). The quote link is set
-- when the operator clicks "Calculate Quote".
--
-- Reached only via the service-role client (server API routes), so RLS is
-- disabled to match quotes. The base house photo + custom-item images live in
-- the private `designs` Storage bucket and are served via signed URLs.
-- =====================================================================

create table if not exists designs (
  id uuid primary key default gen_random_uuid(),
  quote_id uuid references quotes(id) on delete set null,
  photo_path text,                                          -- Storage path: {designId}/photo.<ext>
  photo_w integer,
  photo_h integer,
  scene jsonb not null default '{"yardsticks":[],"items":[]}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table designs disable row level security;

-- At most ONE design per quote (for linked designs); unlimited UNLINKED designs
-- (quote_id NULL — Postgres treats NULLs as distinct, so the partial unique
-- index only constrains rows that actually point at a quote).
create unique index if not exists designs_quote_id_uniq
  on designs (quote_id) where quote_id is not null;
create index if not exists designs_created_at_idx on designs (created_at desc);

-- Keep updated_at fresh on every write (mirrors the renders trigger).
create or replace function designs_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists designs_updated_at_trigger on designs;
create trigger designs_updated_at_trigger
  before update on designs
  for each row execute function designs_set_updated_at();

-- Storage bucket for design artifacts (base house photo + custom-item images).
-- Private; reads go through service-role signed URLs (same pattern as renders).
insert into storage.buckets (id, name, public)
values ('designs', 'designs', false)
on conflict (id) do nothing;
