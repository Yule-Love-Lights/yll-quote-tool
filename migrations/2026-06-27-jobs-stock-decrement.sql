-- #82 Phase 2 (stock loop): records WHEN a job's materials were prepped and its
-- on-hand stock decremented, so the decrement fires exactly once per job
-- (idempotent "prepare" — Naldo's Q4: stock decremented only at prep).
--
-- Additive + idempotent. Nullable: NULL = not yet prepped/decremented. The
-- prepare action claims a job by stamping this column WHERE it is still NULL
-- (an atomic guard against a double-decrement), then deducts on-hand.
--
-- ⚠️ APPLY TO LIVE SUPABASE BEFORE THE DEPENDENT CODE MERGES (prod auto-deploys
-- master; src/lib/inventory/jobs.ts prepareJobMaterials reads/writes this column).
BEGIN;

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS stock_decremented_at timestamptz;

COMMIT;
