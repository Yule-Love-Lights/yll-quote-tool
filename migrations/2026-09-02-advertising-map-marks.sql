-- =====================================================================
-- Places Naldo marks on the map (2026-09-01 zoning conversation).
--
-- Two things the crew needs and the tool could not hold: WHERE TO GO (a
-- busy intersection, a stretch off the highway) and WHERE NOT TO (a town
-- that fines, a property that complained). Both are the owner's knowledge,
-- not something the data can derive: there is no results data yet to rank
-- spots by, and a no-go is often a phone call nobody logged.
--
-- One table for both, separated by `kind`, because they are the same shape
-- and the crew reads them on the same map. A mark is a POINT with an
-- optional radius: a single corner is a point, "anywhere in this village"
-- is a point with a few hundred metres on it. Polygons were deliberately
-- not modelled: nothing needs one yet, and a radius is far easier to place
-- from a phone than a traced outline.
--
-- Deliberately NOT tied to the residential rule. The tool already refuses a
-- yard sign on residential land from OpenStreetMap's own classification;
-- these marks are the human layer on top, and an avoid mark can sit on a
-- road the classifier thinks is fine. Both are consulted; neither replaces
-- the other.
--
-- active is a soft retire: a hot spot that stops performing should stop
-- being shown without deleting the record of having tried it.
--
-- RLS ENABLED, ZERO POLICIES (service-role only, the advertising default).
-- HOW TO APPLY: safe/additive per AGENTS.md - one brand-new table, indexes
-- that cannot collide with existing data, RLS-enable on a brand-new table.
-- =====================================================================

create table if not exists public.advertising_map_marks (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('hotspot', 'avoid')),
  label       text not null check (length(btrim(label)) > 0),
  note        text,
  lat         double precision not null check (lat >= -90 and lat <= 90),
  lng         double precision not null check (lng >= -180 and lng <= 180),
  -- Null means a single point. A number means "this whole area", drawn as a
  -- circle, which is what a phone can actually place.
  radius_m    integer check (radius_m is null or (radius_m > 0 and radius_m <= 20000)),
  active      boolean not null default true,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists advertising_map_marks_kind_idx
  on public.advertising_map_marks (kind, active);

create index if not exists advertising_map_marks_created_idx
  on public.advertising_map_marks (created_at desc);

drop trigger if exists advertising_map_marks_updated_at on public.advertising_map_marks;
create trigger advertising_map_marks_updated_at
  before update on public.advertising_map_marks
  for each row execute function public.advertising_set_updated_at();

alter table public.advertising_map_marks enable row level security;
