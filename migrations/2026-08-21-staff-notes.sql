-- =====================================================================
-- staff_notes - append-only internal notes shared by a quote and its
-- linked job/invoice admin pages.
--
-- Service-role only: RLS is enabled with no anon/authenticated policies.
-- The application exposes these rows only through a fail-closed operator
-- route. Notes are not part of quote/portal/PDF payloads.
--
-- Safe/additive: brand-new table, indexes on an empty table, and RLS with
-- zero browser policies. Apply before deploying code that reads this table.
-- =====================================================================

create table if not exists public.staff_notes (
  id                  uuid primary key default gen_random_uuid(),
  quote_id            uuid not null references public.quotes(id) on delete cascade,
  body                text not null,
  created_by          uuid references auth.users(id) on delete set null,
  created_by_label    text not null,
  created_at          timestamptz not null default now(),
  client_request_id   uuid not null,

  constraint staff_notes_body_valid
    check (body = btrim(body) and char_length(body) between 1 and 2000),
  constraint staff_notes_created_by_label_valid
    check (
      created_by_label = btrim(created_by_label)
      and char_length(created_by_label) between 1 and 320
    ),
  constraint staff_notes_quote_request_unique
    unique (quote_id, client_request_id)
);

create index if not exists staff_notes_quote_created_idx
  on public.staff_notes (quote_id, created_at desc, id desc);

alter table public.staff_notes enable row level security;

-- Explicit grants make the intended boundary independent of changing
-- Supabase defaults. The application is append-only: no UPDATE/DELETE grant.
revoke all on public.staff_notes from anon, authenticated;
grant select, insert on public.staff_notes to service_role;

comment on table public.staff_notes is
  'Internal staff-only quote timeline, also shown on the linked job and invoice. Never customer-facing.';
