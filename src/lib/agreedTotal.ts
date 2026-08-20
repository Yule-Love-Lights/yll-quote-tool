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
// `delta` (new_total − previous_total of that amendment) lets amendedAgreedTotal
// advance the shift basis by everything already applied. `consent` (review
// HIGH, ledger #83 decline follow-up): a DECLINED entry's new_total/delta were
// never agreed to — both resolveAgreedTotal and amendedAgreedTotal below skip
// them; see isDeclined.
type AmendmentLike = {
  new_total?: number | null;
  delta?: number | null;
  consent?: { status?: string | null } | null;
};

// True only for an entry the customer explicitly refused. Missing consent /
// 'pending' / 'accepted' are NOT declined — a pending amendment is still
// picked up (pre-existing, deliberate; see resolveAgreedTotal's precedence
// doc) and an accepted one obviously is.
function isDeclined(a: AmendmentLike | null | undefined): boolean {
  return a?.consent?.status === 'declined';
}

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
 *   1. the LAST NON-DECLINED amendment's new_total  (an amendment re-prices the
 *      agreement — but only once the customer hasn't refused it; see below)
 *   2. approval_snapshot.customerSelection.currentTotalUsd  (the approved selection)
 *   3. result.total  (a never-approved / legacy row with no snapshot)
 *   4. 0  (nothing priceable)
 *
 * A malformed snapshot at any rung falls through to the next.
 *
 * Review HIGH (ledger #83 decline follow-up): a DECLINED amendment is a price
 * the customer explicitly REFUSED, not one they agreed to — walking straight
 * to the newest entry's new_total (the pre-fix behavior) picked up a declined
 * bump as "the agreed total" for every consumer of this function
 * (createInvoiceFromJob, setInvoiceTaxOverride, Wisetack financing, the
 * home.works estimate, free-items/apply-color-request), so a job completing
 * right after a decline would invoice the figure the customer said no to.
 * Skipping a declined entry and continuing the walk back to the next
 * non-declined one (accepted or still-pending) handles any mix — a lone
 * decline, two declines in a row, decline-then-a-later-accept, accept-then-a-
 * later-decline — by construction, since the walk just keeps going past each
 * declined entry. PENDING is deliberately UNCHANGED: a pending amendment is
 * still picked up as agreed (pre-existing behavior — staff re-priced it, and
 * collection is separately gated by blocksSettlement, not by this function).
 */
export function resolveAgreedTotal(
  snapshot: AgreedTotalSnapshot,
  result: Pick<QuoteResult, 'total'> | { total?: number | null } | null | undefined,
): number {
  const amendments = Array.isArray(snapshot?.amendments) ? snapshot!.amendments! : [];
  // Walk from the newest amendment backwards for the first finite new_total,
  // treating a DECLINED entry as if it were never there (skip, keep walking),
  // so a malformed trailing entry OR a refused price doesn't wipe out /
  // masquerade as the earlier valid agreed total.
  for (let i = amendments.length - 1; i >= 0; i--) {
    if (isDeclined(amendments[i])) continue;
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
 * equal to the original divergence. Instead we measure only what STAFF changed
 * since the LAST time the order was priced, and apply that shift to the agreed
 * total:
 *
 *   basis          = approvalFullTotal + Σ(already-applied amendment deltas)
 *   newAgreedTotal = agreedTotal + (currentFullTotal − basis)
 *
 * The basis is the approval-time full total ADVANCED by every amendment already
 * applied. Without that advance, a 2nd (or Nth) amendment would measure against
 * the raw frozen `snapshot.pricing.total` and re-include every prior amendment's
 * change — so two sequential +$500 then +$300 amendments would bill $500 then
 * $800 instead of $500 then $300 (double-count). Each amendment's `delta`
 * (new_total − previous_total) equals the full-total shift it applied, so summing
 * the prior deltas moves the basis up to the full total as of the last amendment;
 * `currentFullTotal − basis` is then this amendment's own increment.
 *
 * When no builder edit happened, currentFullTotal === basis → the shift is 0 →
 * the amend correctly reads as no-change (no phantom increase). When the approval
 * snapshot has no frozen full total (legacy rows), we fall back to the current
 * full total as the basis, so both sides are full-scope and the delta is the
 * pre-fix behavior — safe for the non-diverged path.
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
  // Advance the approval-time full basis by every amendment already applied, so
  // THIS amendment measures only its own increment (not the prior amendments').
  //
  // Delta-verify (fix-round self-check, ledger #83 decline follow-up): a
  // DECLINED amendment's delta must NOT count as "already applied" here,
  // consistent with resolveAgreedTotal (above) now skipping the same entry —
  // `agreedTotal` passed in is post-that-fix and already excludes it. Summing
  // a declined delta unconditionally would silently reintroduce the bug one
  // level up: if staff later remove the declined item from the builder
  // (currentFullTotal reverts to the pre-decline scope), the inflated basis
  // would compute a phantom DISCOUNT equal to the never-applied decline; if
  // staff instead re-offer the same item (it's still in the builder),
  // excluding it here correctly re-asks the customer for its full amount
  // instead of silently re-granting it. Worked example: $5,600 full / $5,000
  // agreed; amendment 1 adds a $900 item (full → $6,500), customer DECLINES
  // it (agreedTotal stays $5,000 via resolveAgreedTotal). If staff then remove
  // that item in the builder (full back to $5,600) and record amendment 2:
  // including the declined $900 delta gives basis $6,500, shift $5,600 −
  // $6,500 = −$900, next = $5,000 − $900 = $4,100 (WRONG — nothing changed).
  // Excluding it gives basis $5,600, shift 0, next = $5,000 (correct — reads
  // as no-change, same as if the decline never happened).
  const amendments = Array.isArray(snapshot?.amendments) ? snapshot!.amendments! : [];
  let appliedDelta = 0;
  for (const a of amendments) {
    if (isDeclined(a)) continue;
    const d = a?.delta;
    if (typeof d === 'number' && Number.isFinite(d)) appliedDelta += d;
  }
  const basis = approvalFullTotal + appliedDelta;
  const shift = currentFullTotal - basis;
  const next = agreedTotal + shift;
  return next >= 0 ? next : 0; // never negative (a huge removal clamps to 0)
}
