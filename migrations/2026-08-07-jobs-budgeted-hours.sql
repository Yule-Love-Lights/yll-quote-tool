-- =====================================================================
-- jobs budgeted-hours planning fields (P4P Phase 1, 2026-08-07).
--
-- The jobs table already snapshots quote line_items when a booked quote becomes
-- a job. This migration adds the planning-estimate labor fields that ride on
-- the same row: budgeted hours, labor revenue, a placeholder-rates marker, and
-- future manual-override audit columns.
--
-- HOW TO APPLY: applied directly via Supabase MCP (see AGENTS.md's migration-
-- application default) rather than the manual SQL-editor paste this repo used
-- before 2026-08-07. Idempotent; safe to re-run.
-- =====================================================================

alter table public.jobs
  add column if not exists budgeted_hours numeric,
  add column if not exists labor_revenue_cents integer,
  add column if not exists rates_are_placeholder boolean not null default true,
  add column if not exists budgeted_hours_overridden_at timestamptz,
  add column if not exists budgeted_hours_overridden_by text;
