-- Staff can independently hide the house design or satellite plan from the
-- customer portal without deleting either artifact from the staff design.
alter table public.designs
  add column if not exists portal_show_street_view boolean not null default true,
  add column if not exists portal_show_satellite_view boolean not null default true;
