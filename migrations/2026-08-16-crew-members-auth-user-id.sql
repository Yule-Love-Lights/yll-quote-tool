-- =====================================================================
-- crew_members.auth_user_id - link a crew member to their login in the
-- SHARED auth store (Naldo's ruling, 2026-08-16).
--
-- THE RULING: one shared identity store, so the SAME login works in the
-- Quote Tool and in the Operations Hub, rather than two separate auth
-- systems to keep in sync. This column is the QT-side link from that
-- shared login to the person's pay identity in `crew_members`.
--
-- ⚠️ SHARED IDENTITY IS NOT SHARED AUTHORIZATION. A crew login now lives
-- in the same store as operator logins, and operators can read customer
-- PII. The separation is enforced in code, not here:
--   * `app_metadata.role = 'crew'` marks the account.
--   * `getOperator()` returns NULL for such an account, so
--     `requireOperator` / `requireAdmin` both reject crew.
--   * `src/proxy.ts` is role-aware: a crew session may reach ONLY crew
--     paths, and is 403'd everywhere else.
-- Both halves have tests. Do not add a crew account without them.
--
-- `app_metadata` is writable only through the service-role admin API, so a
-- crew member cannot self-elevate by editing their own profile. That is the
-- same invariant `roleOf` already relies on for admin.
--
-- UNIQUE + nullable: nullable because the four seeded crew members predate
-- any login and stay usable for office-entered time; unique because two
-- crew_members rows must never share one login, which would let one person
-- accrue another's hours.
--
-- HOW TO APPLY: safe/additive per AGENTS.md's migration-application default
-- (nullable column-add plus a unique index that cannot collide - every
-- existing row is NULL and a partial index skips NULLs).
--
-- APPLIED to prod 2026-08-16 and verified by a real query, not the tool's
-- success message: column present as nullable `uuid`, the partial unique index
-- present with its `WHERE (auth_user_id IS NOT NULL)` predicate, the column
-- comment attached, 4 crew rows and 0 linked (expected - no crew logins exist
-- yet). It was applied a few hours after the PR merged because the Supabase MCP
-- had dropped mid-session; the SQL applied was verified byte-identical to
-- master's copy of this file first.
-- =====================================================================

alter table public.crew_members
  add column if not exists auth_user_id uuid;

-- Partial unique: many rows may be NULL (no login yet), but a given login
-- can back at most ONE crew member.
create unique index if not exists crew_members_auth_user_id_key
  on public.crew_members (auth_user_id) where auth_user_id is not null;

comment on column public.crew_members.auth_user_id is
  'Shared-auth-store user id for this crew member (Naldo 2026-08-16: one login serves the Quote Tool and the Operations Hub). Crew accounts carry app_metadata.role=''crew'' and are rejected by getOperator/requireOperator/requireAdmin and by the role-aware proxy.';
