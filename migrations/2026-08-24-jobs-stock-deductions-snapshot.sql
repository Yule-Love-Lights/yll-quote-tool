-- =====================================================================
-- Row 325: per-job materials-deduction SNAPSHOT (2026-08-24).
--
-- prepareJobMaterials (src/lib/inventory/jobs.ts) recomputes the job's
-- materials LIVE via getJobWorkOrder every time it's called, and the cancel
-- route (src/app/api/jobs/[id]/cancel/route.ts) reversed a prepped job's
-- stock the same way — re-running the SAME live projection at cancel time
-- and reversing whatever it currently returns. If the materials rules (the
-- clip/bindings config, the design, the BOM engine) changed between prep and
-- cancel, the reversal silently mis-credits stock: it returns what the
-- CURRENT projection says, not what prep actually took off the shelf.
--
-- Fix: prepareJobMaterials now persists the exact StockDeduction[] it
-- computed, in the SAME atomic update that claims the job as prepped. The
-- cancel route reverses THAT snapshot instead of recomputing. Nullable —
-- a job prepped BEFORE this migration ships has no snapshot; the cancel
-- route falls back to the old live-reconstruction for those legacy jobs
-- only, and says so explicitly in its response note.
--
-- HOW TO APPLY: this migration is INTENTIONALLY LEFT UNAPPLIED by this PR
-- (see docs/context/task_ledger.md row 325's PR body / AGENTS.md's
-- migration-application rules) — the ADD COLUMN itself is on the safe/
-- additive allowlist (nullable, no default needed), but leaving code+
-- migration to land together and apply once the PR is reviewed keeps this
-- change auditable end-to-end.
-- =====================================================================

alter table public.jobs
  add column if not exists stock_deductions jsonb;
