# Dashboard Phase 1 + 2a — Adversarial Review Outcome

> **Date:** 2026-06-24 · **Reviewer:** multi-agent workflow (25 agents, 5 review dimensions ×
> adversarial verification). **Scope:** `master..naldo/dashboard-service-type` (the full #58
> Phase 1 + 2a changeset). **Verdict:** needs-fixes → **all confirmed findings fixed** in commit
> on `naldo/dashboard-service-type`.

## How it ran
5 independent reviewers (correctness · conventions/area-ownership · data-model/query · frontend/design-system · consistency/tests) each produced findings over the diff; every finding was then handed to a skeptic agent prompted to **refute** it. Only findings that survived refutation were kept.

**Raised: 19 → Confirmed: 6** (13 were false positives / intentional-decision flags killed by the verifiers — e.g. NULL=holiday, the homeworks_signed_at install proxy, no `/api/dashboard` route, Permanent/Event showing zero until 2b).

No critical or high blockers. The codebase was found to follow conventions (thin route, logic in `src/lib`, idempotent roll-forward migration folded into FULL-SCHEMA, area-ownership respected).

## Confirmed findings + fixes

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | medium (bug) | `conversionRate` could exceed 100% (e.g. "200%"). `/approve` stamps `customer_approved_at` without `quote_sent_at`, so an offline-closed deal made `approvedCount > sentCount`. | `metrics.ts`: denominator changed from `sent` to **reached = sent OR approved**, so the rate is always in [0,1] and an offline close still counts as a win. Regression test added (asserts ≤ 1). `types.ts` doc aligned. |
| 2 | medium (bug) | A won deal was nagged in the worklist as a stale "never sent" draft (same root cause: approved with no `quote_sent_at`). | `worklist.ts`: skip any approved quote before the draft/sent branches. Regression test added (approved + null sent + old → no item). |
| 3 | medium (test gap) | Customer-dedup precedence (`hl_id ?? email ?? phone ?? name`) was asserted by name but not exercised — inverting the order kept all tests green. | `metrics.test.ts`: added cases where two identity fields compete (same contact id / different emails → 1; same email / different phones → 1). |
| 4 | medium (test gap) | Holiday by-month install attribution (signed-month vs approval-month) was untested. | `serviceMetrics.test.ts`: added a case (approved Sep / signed Oct → lands in the Oct bucket). |
| 5 | low (doc) | Worklist staleness uses `≥` but the type comment said `>`. | `types.ts`: comment aligned to `≥`; exact-boundary test added in `worklist.test.ts`. |
| 6 | low (doc) | `conversionRate` type-doc described the old `approved / sent`. | Updated to the new reached-based definition. |

## Result
Gates after fixes: `tsc` clean · `lint` 0 errors (2 baseline warnings) · **303 tests** (+6). Merge-readiness raised from **needs-fixes → ready**.

> Note: both bugs were latent in **Phase 1** files (`metrics.ts`, `worklist.ts`) but the fixes
> landed in the **Phase 2a** branch (the two are stacked and merge together; neither manifests
> with current data since there are 0 approved quotes). The Phase 1 PR description notes this.
