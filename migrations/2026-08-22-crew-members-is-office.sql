-- =====================================================================
-- crew_members.is_office - mark a person as OFFICE staff vs FIELD crew
-- (Naldo, 2026-08-22: "add an office/field flag").
--
-- WHY. Office staff (Naldo, Kelly, Ann, Khaye, ...) and field crew share
-- this one labor/identity table - it holds the pay identity every clock
-- lane rolls hours into. But the two populations clock DIFFERENTLY:
--   * FIELD crew  -> a crew-role login and/or a Telegram id; punches come
--                    from the PWA and the Telegram bot (source 'pwa' /
--                    'telegram'), managed on Settings -> Accounts -> Crew
--                    logins.
--   * OFFICE staff -> an OPERATOR login; punches come from the dashboard
--                    office web clock (source 'office'). They never need a
--                    crew-role login or a Telegram link.
-- The Crew logins panel lists this table to hand out crew logins + Telegram
-- links, so office staff appearing there is noise at best and, at worst, an
-- invitation to create a SECOND crew-role login for someone who already has
-- an operator one. This flag lets that panel (GET /api/admin/crew-accounts)
-- filter office staff out.
--
-- SCOPE - PRESENTATION ONLY. This is a QT-internal flag, not part of the
-- Operations Hub contract envelope/enums/events, and the Hub never reads it.
-- The office web clock (a sibling change) resolves an office staffer by their
-- OPERATOR session, NOT by this flag, so flipping it never changes who can
-- clock in - it only changes who shows in the crew-logins panel. When Hub
-- department memberships land (contract Flow I), the office/field split
-- becomes a department fact and this flag is superseded; until then it is the
-- pragmatic QT-side distinction.
--
-- HOW TO APPLY: safe/additive per AGENTS.md's migration-application default -
-- a NOT NULL column add with a default backfills every existing row to the
-- default (false = field crew), the population-agnostic case that default is
-- for. No existing row can violate it.
--
-- The specific people are marked office by a separate one-time data UPDATE
-- (keyed by id, not baked into this migration file), the same way the
-- auth_user_id links were done - env-specific prod ids do not belong in a
-- migration meant to run on any DB.
-- =====================================================================

alter table public.crew_members
  add column if not exists is_office boolean not null default false;

comment on column public.crew_members.is_office is
  'QT-internal presentation flag (Naldo 2026-08-22): true = OFFICE staff (operator login + office web clock), false = FIELD crew (crew login / Telegram clock). Excludes office staff from the Settings crew-logins panel. NOT part of the Operations Hub contract; the office web clock resolves office staff by their operator session, not by this flag.';
