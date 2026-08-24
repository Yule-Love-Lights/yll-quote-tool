-- Server-timed staff quote-building sessions. A session starts when staff
-- accepts a contact (or opens a prefilled draft), links to one quote, and is
-- completed only by that quote's first real sent transition. Test quotes and
-- retries/resends never complete a row.

create table if not exists public.quote_build_sessions (
  id                uuid primary key,
  started_at        timestamptz not null default now(),
  start_reason      text not null
                      check (start_reason in ('contact_selected', 'prefilled_open')),
  started_by        uuid references auth.users(id) on delete set null,
  started_by_label  text not null
                      check (char_length(btrim(started_by_label)) between 1 and 200),
  quote_id          uuid references public.quotes(id) on delete cascade,
  sent_at           timestamptz,

  constraint quote_build_sessions_valid_completion
    check (sent_at is null or (quote_id is not null and sent_at >= started_at))
);

-- One first-build duration per quote. The partial index also supports quote
-- deletion and first-send completion lookups.
create unique index if not exists quote_build_sessions_quote_id_uidx
  on public.quote_build_sessions (quote_id)
  where quote_id is not null;

create index if not exists quote_build_sessions_started_by_idx
  on public.quote_build_sessions (started_by);

create index if not exists quote_build_sessions_sent_at_idx
  on public.quote_build_sessions (sent_at desc, id)
  where sent_at is not null;

alter table public.quote_build_sessions enable row level security;

-- Private operational analytics: only server-side service-role code can read
-- or write. No DELETE grant and no RLS policies.
revoke all on table public.quote_build_sessions from public, anon, authenticated, service_role;
grant select, insert, update on table public.quote_build_sessions to service_role;
