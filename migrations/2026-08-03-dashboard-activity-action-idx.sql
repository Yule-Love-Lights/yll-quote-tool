-- ─────────────────────────────────────────────────────────────────────────
-- Migration: partial index on dashboard_activity operator actions (#189)
-- ─────────────────────────────────────────────────────────────────────────
-- The prod /inbox, / (dashboard), and /insights pages all call
-- getReopenCounts(), which runs six `action = 'handled' | 'reopened'`
-- lookups against dashboard_activity. The table holds ~937k rows, 99.86%
-- of them `action = 'ingested'` (the every-minute reconcile cron re-logs
-- ~20k/day for the same ~600 open items — see the #189 ledger row), and
-- the only indexes were id / inbox_item_id / created_at. Each lookup was
-- therefore a full seq scan: 11.6s measured by EXPLAIN ANALYZE on prod
-- (2026-08-03), which is exactly the 9–15s `getReopenCounts=` figure in
-- the #185 [inbox-timing] log lines — it alone set the page's total.
--
-- Partial index over the NON-firehose actions only (~760 rows today, and
-- it stays tiny however fast the 'ingested' flood grows):
--   • getReopenCounts' `action = 'handled'` / `= 'reopened'` (+ optional
--     created_at window) provably implies the predicate → index scan.
--   • listActivity's `NOT action IN ('ingested','escalated')` carries the
--     same predicate — planner proof expected but VERIFIED BY EXPLAIN
--     post-apply (PostgREST's not.in parse tree isn't byte-identical to
--     the index's), and a residual in-memory sort of the ~760 qualifying
--     rows remains for its created_at ordering (trivial at that count).
-- Plain CREATE INDEX (not CONCURRENTLY — safe inside a txn-wrapped apply
-- path): the build's full heap scan over 937k rows is bounded by the
-- 11.6s measured predicate scan, so expect up to ~10–15s of SHARE lock —
-- writes (the cron's ~14 rows/min + any operator action-insert) QUEUE for
-- that window, they don't fail. Apply in a quiet-traffic window; if the
-- apply path can't hold the lock, fall back to CREATE INDEX CONCURRENTLY
-- pasted as a single autocommit statement in the Supabase SQL editor.
-- Idempotent: IF NOT EXISTS, per CONVENTIONS.md §6.
-- Applies out-of-band directly on prod (Supabase MCP apply_migration, on
-- Jason's named go); this file documents it. Additive + code-independent:
-- no read path changes, so migration order is unconstrained.

CREATE INDEX IF NOT EXISTS dashboard_activity_operator_actions_idx
  ON public.dashboard_activity (action, created_at DESC)
  WHERE action NOT IN ('ingested', 'escalated');
