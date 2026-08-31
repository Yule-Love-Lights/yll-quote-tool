-- The crew door (ledger row 466), pre-merge review round on PR #1094.
--
-- Two findings from that round, both about a link being a bearer credential
-- that travels through a chat app:
--
-- 1. Link tokens were replayable inside their 15-minute window (technical LOW
--    and admin MED, converging). `last_link_jti` makes a link SINGLE USE: the
--    mint stamps a fresh id, the entry route consumes it with a compare-and-set,
--    and a second redemption of the same link finds nothing to consume. It also
--    means minting a new link invalidates the previous one, so an office
--    staffer who re-sends a link has revoked the old one by doing so.
--
-- 2. Nothing recorded who was sent a link or who walked through the door
--    (admin MED). `crew_access_events` is the same audit shape the rest of the
--    repo already uses (dashboard_activity, advertising_activity): append-only,
--    actor + action + detail, and the crew FK nulls on delete so removing a
--    crew member never erases the history of their access.

alter table public.crew_members
  add column if not exists last_link_jti text;

create table if not exists public.crew_access_events (
  id             uuid primary key default gen_random_uuid(),
  crew_member_id uuid references public.crew_members(id) on delete set null,
  actor          text not null,                -- auth.users id (as text), or 'crew'
  action         text not null check (action in ('link_minted', 'entered', 'entry_refused')),
  detail         jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists crew_access_events_crew_member_idx
  on public.crew_access_events (crew_member_id, created_at desc);

alter table public.crew_access_events enable row level security;
