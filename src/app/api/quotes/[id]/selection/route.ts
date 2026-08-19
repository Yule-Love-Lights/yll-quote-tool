// Ledger row 239 — persist the customer's LIVE, still-editable portal
// selection so it survives a device change (phone → laptop): what this route
// actually delivers today. It does NOT give staff any visibility into it —
// no staff surface reads this column yet; PortalBrowsingSelection.savedAt
// (components/portal/types.ts) is explicitly the seam a FUTURE staff view
// would use, not a capability that exists now. FIX E (technical lens, LOW,
// row 239 fix round) corrected this header, which previously described that
// future seam as already delivered. Fired client-side by
// usePersistedSelection (src/lib/portal/usePersistedSelection.ts), debounced
// + deduped so an unchanged selection — the overwhelming majority of opens —
// never triggers a write.
//
// POST /api/quotes/[id]/selection
// Body: { packageId, selectedItemIds, rushSelected, takedownSelected,
//         installTiming, colorSchemeId?, customPattern?, permanentEffect? }
// Response:
//   { ok: true }                                    — saved
//   { ok: true, skipped: 'staff' | 'not-sent' | 'approved' | 'inactive' }
//   { error: string }                                — on failure
//
// Design notes (see the migration + adapter.ts's resolveBrowsingSelectionSeed
// for the full reasoning):
//   * Writes to `quotes.browsing_selection`, NEVER `approval_snapshot` — that
//     column is the frozen agreement and is written exactly once, by
//     /api/quotes/[id]/approve. This route explicitly REFUSES to write once
//     customer_approved_at is set (both a fast-path check and a `.is(...,
//     null)` guard on the write itself, closing the same read-then-write race
//     the approve route guards against) so a browsing-state autosave can never
//     land after — and therefore never shadow or get confused with — approval.
//   * This is a PUBLIC, unauthenticated-by-design route (the quote UUID in the
//     URL is the capability token, same model as /view and /interested) — the
//     client is expected to call it only after debouncing + deduping unchanged
//     values, and this route rate-limits on top as a second layer.
//   * Nothing here is trusted for money math. Price is always recomputed live
//     from the quote's real result/lineItems (SelectionContext / priceSelection
//     on read, the server recompute in approve/route.ts on charge) — this
//     column only ever seeds what the portal opens ON, and even that seed is
//     reconciled against the CURRENT catalog before use (resolveBrowsingSelectionSeed).
//   * Validation here is intentionally light (shape/type only, not "does this
//     id still exist on the quote") — that reconciliation happens at READ time
//     against whatever the catalog looks like THEN, which can't be done
//     correctly at write time anyway (the catalog can change again before the
//     next visit). This mirrors /view and /interested's own light-touch model.
//   * FIX C (technical lens, MED, row 239 fix round) — ACCEPTED, not fixed:
//     the debounced fetch and the page-leave beacon are independent, unordered
//     requests with no version/timestamp from the client, and the write below
//     stamps browsing_selection_updated_at = now() unconditionally, so an
//     older in-flight fetch CAN land after a newer beacon if it happens to be
//     slower. usePersistedSelection.ts's onLeave() already cancels any
//     pending, not-yet-FIRED debounce timer before sending the beacon, so a
//     beacon never races an unfired timer — the only residual window is an
//     ALREADY in-flight older request (issued before the customer's last
//     change) landing late. Left unordered because the stakes don't justify a
//     client-sent sequence number + a server-side conditional write: this
//     column is only ever a pre-fill for the customer's NEXT visit, always
//     reconciled against the live catalog before use
//     (resolveBrowsingSelectionSeed) and immediately re-editable — it's never
//     money and never the frozen approval (which has its own, real, guarded
//     write above). Out of scope: cross-device last-write-wins is a separate,
//     explicitly-accepted gap (two different people holding the same link) —
//     see usePersistedSelection.ts.
//   * Auth model mirrors /view + /approve: the quote UUID is the capability
//     token. Rate-limited to blunt abuse.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { isStaffPreview } from '@/lib/auth/staffDevice';
import { isPermanentEffect } from '@/lib/design/permanentScenes';
import { isPortalActionable } from '@/lib/quoteStatus';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Generous but bounded — a real quote never carries anywhere near this many
// line items or palette colors; the cap is only defense against an abusive
// payload, not a realistic limit any customer could hit.
const MAX_ITEM_IDS = 500;
const MAX_PATTERN_COLORS = 100;

// FIX B (technical lens, MED, row 239 fix round): the two caps above bound
// how MANY ids/colors a payload can carry, but nothing capped how LONG each
// individual string could be — this is a public, unauthenticated route (see
// header), so anyone holding a quote link could post up to MAX_ITEM_IDS
// multi-KB strings at 30/min, real jsonb write amplification the sibling
// public routes (/view, /interested) never expose because they take no
// attacker-shaped body at all.
//
// 200 is generous for every real value here: a scene-item id is
// crypto.randomUUID() stripped of dashes and sliced to 12 chars
// (editor-core/editor.ts's cryptoId), a free-item id is a full
// crypto.randomUUID() (36 chars, free-items/route.ts), a colorSchemeId is
// either a fixed catalog slug (≤19 chars, design/colorSchemes.ts) or
// 'custom', and a customPattern entry is a palette color id — either a
// built-in slug (≤19 chars, editor-core/colors.ts) or a custom palette
// color's crypto.randomUUID() (36 chars, settings/page.tsx). 200 also
// matches this codebase's existing convention for an id/name-shaped field
// elsewhere (estimate/contact's
// MAX_LEN.name, the HighLevel attach route's contactName/contactEmail caps,
// the Homeworks signed route's homeworksContractId cap — all 200).
const MAX_STRING_LEN = 200;

type QuoteRow = {
  id: string;
  customer_approved_at: string | null;
  quote_sent_at: string | null;
  // FIX D (technical lens, LOW, row 239 fix round) — the persisted lifecycle
  // status; see the guard below.
  status: string | null;
};

type SelectionBody = {
  packageId: 'A' | 'B' | 'C' | 'D';
  selectedItemIds: string[];
  rushSelected: boolean;
  takedownSelected: boolean;
  installTiming: 'none' | 'september' | 'october';
  colorSchemeId?: string;
  customPattern?: string[];
  permanentEffect?: string;
};

/** Loose shape/type validation only — see the route header for why full
 *  catalog reconciliation deliberately does NOT happen here. Returns null for
 *  a body missing/mistyping either REQUIRED field (packageId, selectedItemIds);
 *  every other field is sanitized/defaulted rather than rejected, since a
 *  stale or malformed optional value is harmless to store (the read-side
 *  reconciliation and SelectionProvider's own resolveInitialColorState /
 *  isPermanentEffect guards already tolerate garbage there). */
export function parseSelectionBody(body: unknown): SelectionBody | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const packageId = b.packageId;
  if (packageId !== 'A' && packageId !== 'B' && packageId !== 'C' && packageId !== 'D') return null;
  if (!Array.isArray(b.selectedItemIds)) return null;
  const selectedItemIds = b.selectedItemIds
    .filter((x): x is string => typeof x === 'string' && x.length <= MAX_STRING_LEN)
    .slice(0, MAX_ITEM_IDS);
  const installTiming =
    b.installTiming === 'september' || b.installTiming === 'october' ? b.installTiming : 'none';
  const customPattern = Array.isArray(b.customPattern)
    ? b.customPattern
        .filter((x): x is string => typeof x === 'string' && x.length <= MAX_STRING_LEN)
        .slice(0, MAX_PATTERN_COLORS)
    : undefined;
  return {
    packageId,
    selectedItemIds,
    rushSelected: b.rushSelected === true,
    takedownSelected: b.takedownSelected === true,
    installTiming,
    // FIX B: an over-length colorSchemeId is dropped (same treatment as a
    // non-string value) rather than truncated — a truncated id wouldn't match
    // any real scheme anyway, and the read side already tolerates a missing
    // colorSchemeId (falls back to the default scheme).
    ...(typeof b.colorSchemeId === 'string' && b.colorSchemeId.length <= MAX_STRING_LEN
      ? { colorSchemeId: b.colorSchemeId }
      : {}),
    ...(customPattern ? { customPattern } : {}),
    ...(isPermanentEffect(b.permanentEffect) ? { permanentEffect: b.permanentEffect } : {}),
  };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const rl = rateLimitResponse(req, { bucket: 'quote-selection', limit: 30, windowMs: 60_000 });
  if (rl) return rl;

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  // A staff preview of the portal must never overwrite the customer's own
  // saved browsing state (same staff-device cookie / operator-session check
  // the /view and /interested routes use). Skip before any DB work.
  if (await isStaffPreview(req)) {
    return NextResponse.json({ ok: true, skipped: 'staff' });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = parseSelectionBody(body);
  if (!parsed) {
    return NextResponse.json({ error: 'Invalid selection payload' }, { status: 400 });
  }

  const sb = getSupabaseServiceClient()!;
  const { data: quote, error: fetchErr } = await sb
    .from('quotes')
    .select('id, customer_approved_at, quote_sent_at, status')
    .eq('id', id)
    .single<QuoteRow>();
  if (fetchErr || !quote) {
    return NextResponse.json({ error: `Quote not found: ${fetchErr?.message ?? 'no row'}` }, { status: 404 });
  }

  // Mirrors /view + /interested: a staff preview of an unsent quote is not a
  // real customer interaction yet.
  if (!quote.quote_sent_at) {
    return NextResponse.json({ ok: true, skipped: 'not-sent' });
  }

  // The frozen approval always wins — never let a browsing-state autosave land
  // after approval (it must never shadow or get confused with approval_snapshot).
  if (quote.customer_approved_at) {
    return NextResponse.json({ ok: true, skipped: 'approved' });
  }

  // FIX D (technical lens, LOW, row 239 fix round) — defense-in-depth: a
  // quote that was sent, never approved, then moved to a terminal/branch
  // state (declined, cancelled, abandoned) or is under revision
  // (changes_requested) still has customer_approved_at === null, so without
  // this it would fall through to the write below. isPortalActionable is the
  // SAME check page.tsx already uses to gate the portal UI — once a quote is
  // non-actionable the page shows a "no longer available" / "being updated"
  // screen and never mounts <SelectionProvider>, so the client never reaches
  // this route in that state; this only guards a hand-crafted POST holding
  // the capability UUID. Impact is cosmetic (a stale browsing_selection
  // value), not a real race with anything of consequence, so this is a
  // fast-path check only — no `.eq('status', ...)` re-check on the write
  // itself the way the approval guard has one. Fail-open on a null/legacy
  // status (isPortalActionable's own contract) keeps pre-migration rows
  // working exactly as before this fix.
  if (!isPortalActionable(quote.status)) {
    return NextResponse.json({ ok: true, skipped: 'inactive' });
  }

  const { packageId, selectedItemIds, rushSelected, takedownSelected, installTiming, colorSchemeId, customPattern, permanentEffect } =
    parsed;

  // `.is('customer_approved_at', null)` re-asserts, on the write itself, the
  // same condition the fetch above just saw — closing the TOCTOU window where
  // an approval lands between the fetch and this write (mirrors the approve
  // route's own guarded update, and the AGENTS.md sibling-guard-parity rule:
  // a mutating action on this row gets the same re-check its neighbors have).
  // A miss here (0 rows updated) means approval won the race — non-fatal,
  // since a late browsing-state write losing that race is exactly the
  // intended outcome, not an error to surface to the customer.
  const { error: updateErr } = await sb
    .from('quotes')
    .update({
      browsing_selection: {
        packageId,
        selectedItemIds,
        rushSelected,
        takedownSelected,
        installTiming,
        ...(colorSchemeId ? { colorSchemeId } : {}),
        ...(customPattern ? { customPattern } : {}),
        ...(permanentEffect ? { permanentEffect } : {}),
      },
      // Stamped unconditionally, no ordering check against a client
      // timestamp — see the route header's FIX C note for why an
      // out-of-order landing here is an accepted, low-stakes gap.
      browsing_selection_updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .is('customer_approved_at', null);
  if (updateErr) {
    console.error('[api/quotes/:id/selection] update failed:', updateErr);
    return NextResponse.json({ error: `Failed to save selection: ${updateErr.message}` }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
