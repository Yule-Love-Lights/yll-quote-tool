# Advertising payout settlement — build spec (ledger row 481)

Written at the S80 close (2026-08-29) so the build can start cold in a later
session. Naldo's instruction: have it ready, not built today.

## The gap, in one line

The tool knows what every advertising worker has **earned**. Nothing records
that the money was **handed over**, so the pay screen shows a cumulative
earned figure forever and the office has no in-app answer to "did we pay Joe
for last week yet?"

## What already exists (do not rebuild)

- `summarizeEarnings` / `earningsSummary({ workerId? })` in
  `src/lib/advertising/placements.ts` is the ONE money engine. It returns
  `WorkerEarningsSummary`: `{ workerId, total: { pendingEstimatedCents,
  acceptedEarnedCents }, byDay[], byWeek[] }`, ET day and Monday-week buckets,
  paged to completeness, excluding `is_test` and voided rows.
- Earned = the rate **stamped on each accepted placement** at acceptance
  (`accepted_rate_cents`). Rate changes never move history. Pending is an
  estimate at the campaign's current rate and is NOT money owed.
- Read surfaces: `GET /api/admin/advertising/earnings` (all workers, admin),
  `GET /api/advertising/earnings` (the worker's own), `/admin/advertising/pay`,
  and `PayScreen.tsx` in the Simple Crew replica.
- `advertising_activity` is the append-only audit trail; write through
  `logAdvertisingActivity` only.

## What to build

### The design decision that matters most

A settlement must say **which placements it paid**, not just "week of Aug 24,
$47.50". Period-only settlement drifts the moment a placement inside an
already-paid week is accepted late (a real case: review happens days after
capture), and the office cannot tell an underpayment from a late acceptance.

**Recommended: settlement LINES referencing placement ids.**

- `advertising_settlements`: id, worker_id, total_cents, paid_at, paid_by
  (auth user), method (text, nullable), note, created_at.
- `advertising_settlement_lines`: settlement_id, placement_id **UNIQUE**,
  amount_cents.

The unique constraint on `placement_id` is the whole safety property: a
placement can be paid at most once, enforced by the database rather than by
remembering. `amount_cents` copies the placement's stamped rate at settle
time, so the settlement is its own record even if anything upstream changes.

### Derived numbers (never stored)

- `settledCents(worker)` = sum of that worker's settlement lines.
- `unpaidCents(worker)` = `acceptedEarnedCents − settledCents`. Derived, so it
  cannot drift, exactly like `remaining` in `signIssuances.ts`.

### Data layer (`src/lib/advertising/payouts.ts`)

- `listPayableePlacements(workerId)` — accepted, not voided, not `is_test`, not
  already on a settlement line. This is the payable set.
- `recordSettlement(workerId, placementIds, paidBy, { method, note })` —
  re-reads each placement, refuses any that is voided or already settled,
  sums the STAMPED rates (never a re-computed rate), writes the settlement and
  its lines in one insert path, audits `settlement_recorded` with the total,
  the line count and the acting admin. Idempotent under a double-submit the
  way `issueSigns` is: the unique constraint is the backstop, and a lost race
  surfaces as a named conflict rather than a 500.
- `getWorkerPayoutSummary(workerId)` — earned, settled, unpaid, last paid date.

### Routes + UI

- `GET/POST /api/admin/advertising/settlements` (requireAdmin; the payer is
  always the admin session, never the body).
- Pay screen: per worker show **Earned · Paid · Unpaid**, a "Mark paid"
  action defaulting to every payable placement, with the dollar amount echoed
  in a confirm before it writes (the campaign-rate lesson: a money action
  states its number before committing).
- The worker's own screen should show what they have been paid, not only
  earned — that is the number they will ask about.

## Money traps to test FIRST (write these failing, then build)

1. `unpaid = earned − settled`, per worker, in integer cents.
2. A placement can be settled **at most once** — second attempt refused, and
   the refusal is a named conflict, not a crash.
3. Settling **never changes** `acceptedEarnedCents`; earned is history.
4. A **voided** placement is never payable, and a placement voided *after*
   being settled does not silently reduce a past settlement.
5. A double-submitted "Mark paid" records **one** settlement, not two.
6. `is_test` workers and rows never enter a real settlement.
7. A settlement covering zero payable placements is refused rather than
   writing a $0.00 record.
8. Sum-of-lines equals the settlement total, always (assert it in the write).

Mutation-probe every guard: remove it, watch exactly the intended test fail,
restore.

## Open questions for Naldo (ask BEFORE building)

1. **A paid placement is later voided** — refuse the void, or allow it and
   record a negative adjustment the next settlement nets out? (Refusing is
   simpler and honest; allowing needs a credit concept.)
2. **Payment method** — worth tracking cash / Venmo / check, or is a free-text
   note enough?
3. **Batch shape** — "pay everything outstanding" per worker, or pick a week?
   (The line-based design supports both; this is only about the default.)
4. Should the worker's own screen show a payment history, or just a running
   "paid to date"?

## Guardrails carried from the advertising build

- Integer cents everywhere; never multiply a float by 100.
- Money reads page to completeness; PostgREST silently caps an unranged select
  at 1000 rows.
- Every money-moving action writes an audit row with the acting admin, and a
  failed write logs nothing.
- The migration is additive; apply it per the AGENTS.md rule, verify the
  applied SQL is byte-identical, and negative-control every CHECK live.
- Update `migrations/FULL-SCHEMA.sql` in the SAME PR.
