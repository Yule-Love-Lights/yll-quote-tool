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
//     !bookedAmendEligible`, OR'd with its client-only `staleApprovalFrozen`
//     self-correction flag. That OR-term is a SUPERSET on the client only: it
//     freezes the tab after the server has already refused a write, so it can
//     never unlock something this predicate locks. The server rule is the one
//     below; the client's is the same rule plus "and stay locked once told".
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

import { NextResponse } from 'next/server';
import { deriveStatus, type QuoteStatusRow } from '@/lib/quoteStatus';
import { getSupabaseServiceClient } from '@/lib/supabase';

/** The quote columns this predicate needs. */
export type SceneFreezeRow = QuoteStatusRow & { is_test?: boolean | null };

/** Wire code on the 409, so a client can tell this apart from a CAS conflict. */
export const SCENE_LOCKED_CODE = 'design-locked';

export const SCENE_LOCKED_MESSAGE =
  'This design is locked — the customer already approved it, so the drawing they signed off on cannot be changed here. ' +
  'If the quote is still open, decline it, revive it, edit, and re-send. A booked order is changed through the amend flow. ' +
  'A cancelled quote cannot be reopened — start a new quote instead.';

export function isSceneFrozen(q: SceneFreezeRow): boolean {
  if (q.is_test) return false;
  if (!q.customer_approved_at) return false;
  return deriveStatus(q) !== 'booked';
}

/**
 * Resolve whether a design's linked quote carries a frozen (approved)
 * agreement.
 *
 * Returns `ok: false` for a read we could NOT confirm — the caller turns that
 * into a retryable failure rather than guessing in either direction. Guessing
 * "unlocked" would be the exact drift this closes; guessing "locked" would
 * block an editor permanently on a transient DB blip AND tell staff a live
 * quote is approved.
 *
 * An unlinked design, or one pointing at a quote row that no longer exists,
 * has no signed-off agreement to protect and is writable.
 */
export type SceneLock =
  | {
      ok: true;
      locked: boolean;
      /** The linked quote, or null for an unlinked design. */
      quoteId: string | null;
      /**
       * Row 423: this quote has a frozen agreement worth auditing a design
       * change against — the customer approved it and it is not a test quote.
       * In practice that means a BOOKED order, since anything approved and not
       * booked is `locked` and no write lands at all. Returned here so the
       * caller gets it from the read it was already doing.
       */
      auditable: boolean;
    }
  | { ok: false };

export async function readSceneLock(designId: string): Promise<SceneLock> {
  const sb = getSupabaseServiceClient();
  if (!sb) return { ok: false };
  const { data: designRow, error: designErr } = await sb
    .from('designs')
    .select('quote_id')
    .eq('id', designId)
    .maybeSingle<{ quote_id: string | null }>();
  if (designErr) {
    console.warn('[sceneFreeze] design read failed:', designErr.message);
    return { ok: false };
  }
  if (!designRow?.quote_id) return { ok: true, locked: false, quoteId: null, auditable: false };
  const { data: quoteRow, error: quoteErr } = await sb
    .from('quotes')
    .select('status, quote_sent_at, viewed_at, customer_approved_at, deposit_paid_at, is_test')
    .eq('id', designRow.quote_id)
    .maybeSingle<SceneFreezeRow>();
  if (quoteErr) {
    console.warn('[sceneFreeze] quote read failed:', quoteErr.message);
    return { ok: false };
  }
  // quote gone — nothing agreed to protect, and nothing to audit onto
  if (!quoteRow) return { ok: true, locked: false, quoteId: null, auditable: false };
  return {
    ok: true,
    locked: isSceneFrozen(quoteRow),
    quoteId: designRow.quote_id,
    auditable: !quoteRow.is_test && !!quoteRow.customer_approved_at,
  };
}

/**
 * The ONE post-approval refusal used by every design write route.
 *
 * Returns a response to send, or null to carry on. Call it BEFORE any mutation
 * — several of these routes write more than one thing (a storage object, then a
 * row, then a scene prune), and a refusal discovered halfway through leaves a
 * half-done change that a 409 then lies about.
 *
 * Row 427: this exists because row 367 froze the design SCENE and four premerge
 * lenses, hunting the same class on a later PR, found four sibling surfaces of
 * the same design still open — the base photo, extra photos, the satellite
 * image, and the satellite trace. Each was a separate route with its own local
 * check or none at all. One shared helper is the point: a route added tomorrow
 * calls this, or it is obvious in review that it did not.
 */
export async function refuseIfFrozen(designId: string): Promise<NextResponse | null> {
  const lock = await readSceneLock(designId);
  if (!lock.ok) {
    // Not a lock and not a licence — a transient read failure must not
    // manufacture a permanent refusal, nor wave the write through.
    return NextResponse.json(
      { error: "Could not verify this design's approval state — nothing was changed." },
      { status: 500 },
    );
  }
  if (lock.locked) {
    return NextResponse.json({ error: SCENE_LOCKED_MESSAGE, code: SCENE_LOCKED_CODE }, { status: 409 });
  }
  return null;
}
