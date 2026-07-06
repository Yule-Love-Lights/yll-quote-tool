---
name: money-review
description: Pass-1 invariant checklist whenever a diff touches money: pricing engine, invoices, charges, webhooks, approve/refund/tax/rebook paths. Catches the recurring under-billing and idempotency holes before commit. Trigger: any money or billing diff, "money review", an adversarial review request on payment code.
---

# Money Review

Every serious production bug in this repo has been silent money math. These invariants
are cheap to check and every one has a real incident behind it. If a hole is visible in
pass 1, close it in pass 1: the two worst bugs were visible early and deferred.

## Invariants (check every one the diff can reach)

1. Totals bill the AGREED basis, not the full quote. Partial approved selections are
   normal (per-side packages make partial the default). Reason: the invoice once
   billed the full `result.total` instead of the approved selection (W1-001, CRITICAL).
2. Tax scales to the agreed basis too. Reason: the tax override subtracted full-quote
   tax from a partial-agreed total, under-billing every partial selection (S23 HIGH).
3. Charges verify captured amount >= balance before marking paid. Reason: the balance
   webhook shipped with no paid-amount check at all (S14b), and the charge route later
   repeated the same hole (S21).
4. Status changes go through `canTransition`, never a direct status write. Reason: a
   direct write once allowed booked -> changes_requested, an illegal transition.
5. Idempotent under retry: the same webhook or button press twice must not double-bill.
6. Money stays integer cents end to end; no float drift from rounding.
7. Rebook strips stale snapshots (rate or pricing freezes) so the new draft re-prices.
   Reason: rebook once carried a frozen `permanentRatesSnapshot` into the new draft.
8. Approval inputs actually gate: an empty e-signature or empty selection disables
   approve. Reason: draw-then-Type-then-draw left a blank canvas with Approve enabled
   (W4-003).

## Process

- Grep-verify any recon claim about money call sites before editing. Reason: a recon
  agent claimed the amend route re-priced via `calculateQuote`; it does not re-price at
  all. Agent claims about money paths are hypotheses until grepped.
- Write the failing test FIRST from the acceptance criteria, then implement to green.
  Reason: tests written first encode the intended math before the implementation can
  bias them.
- If existing prod code shows the same suspicious pattern, flag it as a decision
  instead of silently "fixing" parity. Reason: some patterns are deliberate; a blind
  fix is an unreviewed behavior change.
