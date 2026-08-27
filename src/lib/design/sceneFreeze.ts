// Row 367 — the post-approval freeze for the DESIGN (the picture), the twin of
// the money freeze /api/quote already enforces.
//
// Money is frozen at approval; the drawing was not. `PUT /api/designs/[id]`
// had no status check at all and `QuoteBuilder` passed no locked/readOnly prop
// to `DesignEditor`, while the portal reads the scene LIVE — so staff could
// recolour, respace or regroup a design on a quote the customer had already
// approved (or paid a deposit on) and the picture silently drifted away from
// what they signed off.
//
// The predicate here is deliberately IDENTICAL to the money side's, so the two
// freezes cannot drift apart:
//   • `/api/quote`'s approval freeze  — `existing.customer_approved_at &&
//     !existing.is_test && !amendRepriceAllowed` (route.ts ~783)
//   • `QuoteBuilder`'s `postApprovalFrozen` — `!isTest && approvedAt &&
//     !bookedAmendEligible`
//
// Which means, spelled out:
//   • is_test quotes are exempt (every other freeze in the app exempts them —
//     a test quote stays fully editable regardless of lifecycle stamps).
//   • no `customer_approved_at` ⇒ nothing was ever signed off ⇒ editable.
//   • a BOOKED order stays editable — that is the sanctioned amend path
//     (edit in the builder + Calculate, then record the amendment; see
//     `api/quotes/[id]/amend/route.ts`). Locking it here would leave an
//     amended order with no way to draw what the customer just paid extra for.
//   • everything else past approval (approved-not-yet-booked, and
//     declined/cancelled/abandoned AFTER an approval — `deriveStatus` reports
//     the persisted terminal status, never 'booked') is frozen. Its recovery
//     path is the same one the money freeze names: decline → revive (re-send,
//     which clears `customer_approved_at`) → edit → re-send.

import { deriveStatus, type QuoteStatusRow } from '@/lib/quoteStatus';

/** The quote columns this predicate needs. */
export type SceneFreezeRow = QuoteStatusRow & { is_test?: boolean | null };

/** Wire code on the 409, so a client can tell this apart from a CAS conflict. */
export const SCENE_LOCKED_CODE = 'design-locked';

export const SCENE_LOCKED_MESSAGE =
  'This design is locked — the customer already approved it, so the drawing they signed off on cannot be changed here. ' +
  'To change it: decline this quote, revive it, edit, and re-send. (A booked order stays editable — change it through the amend flow.)';

export function isSceneFrozen(q: SceneFreezeRow): boolean {
  if (q.is_test) return false;
  if (!q.customer_approved_at) return false;
  return deriveStatus(q) !== 'booked';
}
