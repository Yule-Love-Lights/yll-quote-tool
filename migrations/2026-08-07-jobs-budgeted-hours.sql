-- =====================================================================
-- jobs budgeted-hours planning fields (P4P Phase 1, 2026-08-07).
--
-- The jobs table already snapshots quote line_items when a booked quote becomes
-- a job. This migration adds the planning-estimate labor fields that ride on
-- the same row: budgeted hours, labor revenue, a placeholder-rates marker, and
-- future manual-override audit columns.
--
-- HOW TO APPLY: paste into the Supabase SQL Editor and Run. Idempotent; safe to
-- re-run.
-- =====================================================================

BEGIN;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS budgeted_hours numeric,
  ADD COLUMN IF NOT EXISTS labor_revenue_cents integer,
  ADD COLUMN IF NOT EXISTS rates_are_placeholder boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS budgeted_hours_overridden_at timestamptz,
  ADD COLUMN IF NOT EXISTS budgeted_hours_overridden_by text;

COMMIT;
