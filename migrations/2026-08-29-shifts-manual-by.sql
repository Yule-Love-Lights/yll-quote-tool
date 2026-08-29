-- Manual shift entries (2026-08-29, Naldo's ruling): admins can create or
-- correct a shift when a crew member forgot to clock in, reading the GPS
-- timeline beside the form and TYPING the times. `manual_by` records who made
-- the manual entry or the last manual edit; null means the row has only ever
-- been touched by the crew member's own clock actions.
--
-- GPS never writes payroll: this column stamps a HUMAN action; nothing
-- automated ever sets it.
--
-- HOW TO APPLY: one nullable ADD COLUMN on a live table — on the safe/additive
-- allowlist (AGENTS.md migration policy), applied directly via MCP.

alter table public.shifts add column if not exists manual_by text;
