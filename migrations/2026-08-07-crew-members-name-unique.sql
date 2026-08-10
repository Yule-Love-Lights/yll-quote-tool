-- =====================================================================
-- crew_members_display_name_key — closes a real race the pre-merge review
-- caught: crew_members had no unique constraint on display_name, only
-- partial-unique indexes on hub_employee_id/telegram_user_id (both null for
-- admin-seeded rows). Two overlapping applications of the seed migration, or
-- two concurrent calls to crewMembers.ts's insert path with no id, could each
-- pass their own read-then-check and create two rows for the same human —
-- each independently accruing P4P hours/pay. A DB-level constraint is a hard
-- guarantee; an application-level check is not.
--
-- Normalized (lower/trim) to match the exact comparison the seed migration
-- itself uses, so this constraint can never reject something the seed logic
-- would have treated as "already exists."
--
-- HOW TO APPLY: applied directly via Supabase MCP per AGENTS.md's migration-
-- application default (additive index on a 4-row table with no duplicate
-- names — safe/additive). Idempotent; safe to re-run.
-- =====================================================================

create unique index if not exists crew_members_display_name_key
  on public.crew_members (lower(trim(display_name)));
