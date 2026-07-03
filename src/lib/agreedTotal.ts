// The AGREED total for a booked/approved quote — the single source of truth for
// what the customer actually consented to pay (#110 W1-001/004/043).
//
// The full-quote `result.total` is the engine-chosen roofline + ALL items + fees
// + tax. But the customer approves a SELECTION on the portal: they can deselect
// items, pick the cheaper roofline tier, or toggle rush/takedown — so the agreed
// total lives in `approval_snapshot.customerSelection.currentTotalUsd` (server-
// recomputed at approve time), and is later superseded by any amendment's
// `new_total`. Billing off `result.total` over/under-bills every diverging order.
//
// This module resolves that precedence in ONE place so every money consumer
// (invoice creation, tax-override re-price, the convert-to-job deposit clamp,
// the amend delta) agrees. PURE + client-safe — it imports only a type, never
// Supabase. The precedence matches the amend route's long-standing
// previousTotal chain EXACTLY (amend/route.ts): last amendment new_total ??
// snapshot currentTotalUsd ?? result.total ?? 0.

import type { QuoteResult } from './pricing/pricingEngine';

// One appended amendment-trail entry, as far as the agreed-total resolution
// cares. Kept structural (not imported from lib/amend) so this module stays a
// leaf with no extra dependencies; the real AmendmentTrailEntry satisfies it.
type AmendmentLike = { new_total?: number | null };

// The minimal approval snapshot shape the agreed total is read from. A malformed
// / partial snapshot (any field missing or the wrong type) is tolerated — each
// rung is guarded and simply falls through to the next.
export type AgreedTotalSnapshot = {
  customerSelection?: { currentTotalUsd?: number | null } | null;
  amendments?: AmendmentLike[] | null;
  // The full pricing result frozen at approval time. Used only by
  // amendedAgreedTotal (the amend delta), not by resolveAgreedTotal.
  pricing?: { total?: number | null } | null;
} | null;

// A finite, non-negative number, else undefined — so a NaN / Infinity / negative
// / non-number never poisons the resolution and we fall through to the next rung.
function finiteMoney(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Resolve the AGREED total (dollars) the customer consented to, from a quote's
 * approval snapshot + priced result. PURE.
 *
 * Precedence (mirrors amend/route.ts's previousTotal chain EXACTLY):
 *   1. the LAST amendment's new_total  (an amendment re-prices the agreement)
 *   2. approval_snapshot.customerSelection.currentTotalUsd  (the approved selection)
 *   3. result.total  (a never-approved / legacy row with no snapshot)
 *   4. 0  (nothing priceable)
 *
 * A malformed snapshot at any rung falls through to the next.
 */
export function resolveAgreedTotal(
  snapshot: AgreedTotalSnapshot,
  result: Pick<QuoteResult, 'total'> | { total?: number | null } | null | undefined,
): number {
  const amendments = Array.isArray(snapshot?.amendments) ? snapshot!.amendments! : [];
  // Walk from the newest amendment backwards for the first finite new_total, so a
  // malformed trailing entry doesn't wipe out an earlier valid agreed total.
  for (let i = amendments.length - 1; i >= 0; i--) {
    const nt = finiteMoney(amendments[i]?.new_total);
    if (nt !== undefined) return nt;
  }
  const selection = finiteMoney(snapshot?.customerSelection?.currentTotalUsd);
  if (selection !== undefined) return selection;
  const resultTotal = finiteMoney(result?.total);
  if (resultTotal !== undefined) return resultTotal;
  return 0;
}

/**
 * The new agreed total after a builder re-price, on the agreed (selection) basis
 * — the honest amend delta (#110 W1-004). PURE.
 *
 * The amend flow re-prices the WHOLE quote in the builder, so the new
 * `result.total` is full-scope, while the previously agreed total is a SELECTION
 * subset. Subtracting one basis from the other fabricates a phantom increase
 * equal to the original divergence. Instead we measure only what STAFF changed —
 * `result.total − snapshot.pricing.total` (the full total frozen at approval) —
 * and apply that shift to the agreed total:
 *
 *   newAgreedTotal = agreedTotal + (currentFullTotal − approvalFullTotal)
 *
 * When no builder edit happened, currentFullTotal === approvalFullTotal → the
 * shift is 0 → the amend correctly reads as no-change (no phantom increase).
 * When the approval snapshot has no frozen full total (legacy rows), we fall
 * back to the current full total as the basis, so both sides are full-scope and
 * the delta is the pre-fix behavior — safe for the non-diverged path.
 */
export function amendedAgreedTotal(
  snapshot: AgreedTotalSnapshot,
  result: { total?: number | null } | null | undefined,
  agreedTotal: number,
): number {
  const currentFullTotal = finiteMoney(result?.total);
  if (currentFullTotal === undefined) return agreedTotal; // no re-price to measure
  const approvalFullTotal = finiteMoney(snapshot?.pricing?.total);
  // No frozen full total → measure on the full basis (legacy / pre-snapshot).
  if (approvalFullTotal === undefined) return currentFullTotal;
  const shift = currentFullTotal - approvalFullTotal;
  const next = agreedTotal + shift;
  return next >= 0 ? next : 0; // never negative (a huge removal clamps to 0)
}
