// Ledger row 324 — an OPERATOR-AUTHED action that saves a staff-configured
// portal selection (package/items/colour/rush/takedown/timing) as the
// customer's OPENING selection. Jason's ruling (2026-08-20, option (a)):
// staff save is ALWAYS allowed (even before the quote is ever sent — that's
// the row's primary use case), with the UI asking an overwrite confirm when
// the customer has already browsed (see the portal's StaffPreselectBar,
// gated on quote.viewedAt).
//
// This is DELIBERATELY a separate route from /api/quotes/[id]/selection,
// never a loosening of that route's isStaffPreview skip — the row's hard
// design constraint (recorded S44): that skip exists so a staff PREVIEW can
// never SILENTLY overwrite a customer's autosaved browsing state, and nothing
// here touches it. This route is the opposite of silent: it requires a real
// authenticated operator session (requireOperator, not merely the
// STAFF_DEVICE_COOKIE isStaffPreview checks) and only ever fires from an
// explicit staff button click.
//
// POST /api/quotes/[id]/staff-selection   (operator-only)
// Body: the same shape /api/quotes/[id]/selection accepts — see
//       parseSelectionBody (imported from that route, single source of
//       truth for the validation, since the two write the exact same
//       column with the exact same shape).
// Response:
//   { ok: true }                                     — saved
//   { error: string, code: 'locked' }                — 409: approved/booked,
//                                                        the frozen order
//   { error: string, code: 'inactive' }               — 409: closed
//                                                        (cancelled /
//                                                        changes_requested)
//   { error: string }                                 — 400/401/404/500
//
// Guards:
//   - requireOperator() — real authenticated operator session.
//   - NEVER writes once the order is frozen: `customer_approved_at` (or
//     `deposit_paid_at`, belt-and-suspenders for the theoretical case where
//     a deposit landed without it — never happens via this app's own
//     flows, see approve/staff-approve) blocks the write with a 409. The
//     customer /selection route hits the identical condition and silently
//     skips ({ok:true, skipped:'approved'}) because it's an unattended
//     autosave; this route 409s instead — an explicit staff action deserves
//     an explicit failure, not a quiet no-op the operator would never see.
//   - Every OTHER status mirrors the customer route's own write eligibility
//     (isPortalActionable OR isTerminalBrowseStatus — cancelled/
//     changes_requested 409 as 'inactive', declined/abandoned still allowed
//     per row 236's ruling that those portals stay browsable) — EXCEPT the
//     customer route's "not sent yet" skip, which this route deliberately
//     omits: pre-selecting BEFORE the quote is ever sent is the whole point.
//   - `.is('customer_approved_at', null)` re-asserted on the write itself
//     (sibling parity with the customer route's identical TOCTOU re-check,
//     and with staff-approve's status-guarded write) closes the race where
//     an approval lands between the fetch above and this write.
//
// Provenance: the write stamps `browsing_selection.staffSet = { by, at }`
// (additive — adapter.ts's buildBrowsingSelection already tolerates unknown
// jsonb keys) so a future surface — or a later visit to THIS route — can
// tell a staff-set opening selection from a genuine customer edit. The
// customer's own next autosave overwrites it in the normal course of things
// (browsing_selection is one mutable column, not an audit log) — that's
// correct: once the customer edits, their edit is the current truth again.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator, getOperator } from '@/lib/auth/supabaseServer';
import { isPortalActionable, isTerminalBrowseStatus } from '@/lib/quoteStatus';
import { parseSelectionBody } from '../selection/route';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type QuoteRow = {
  id: string;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  status: string | null;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
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
    .select('id, customer_approved_at, deposit_paid_at, status')
    .eq('id', id)
    .single<QuoteRow>();
  if (fetchErr || !quote) {
    return NextResponse.json({ error: `Quote not found: ${fetchErr?.message ?? 'no row'}` }, { status: 404 });
  }

  // The frozen approval always wins — a staff preselect must never land on an
  // approved/booked quote (the approval_snapshot is the durable record from
  // there on). See the route header for why this 409s instead of the
  // customer route's silent skip.
  if (quote.customer_approved_at || quote.deposit_paid_at) {
    return NextResponse.json(
      {
        error: "This quote is already approved — the frozen order can't be pre-selected. Use Amend instead.",
        code: 'locked',
      },
      { status: 409 },
    );
  }

  // Mirrors the customer route's isPortalActionable/isTerminalBrowseStatus
  // eligibility for every other status (see the route header) — deliberately
  // WITHOUT the customer route's "not sent yet" skip.
  if (!isPortalActionable(quote.status) && !isTerminalBrowseStatus(quote.status)) {
    return NextResponse.json(
      { error: 'This quote is closed and can\'t be pre-selected.', code: 'inactive' },
      { status: 409 },
    );
  }

  const operator = await getOperator();
  const {
    packageId,
    selectedItemIds,
    rushSelected,
    takedownSelected,
    installTiming,
    colorSchemeId,
    customPattern,
    permanentEffect,
  } = parsed;

  // `.is('customer_approved_at', null)` re-asserts, on the write itself, the
  // same condition the fetch above just saw — see the route header.
  //
  // Fix-round MED (technical + admin lenses, converging on the same gap —
  // sibling parity with approve/route.ts and staff-decline/route.ts, both of
  // which `.select('id')` the guarded update and check affected rows): a lost
  // TOCTOU race (an approval lands between the fetch above and this write)
  // used to match zero rows and STILL return `{ok:true}` — the exact "quiet
  // no-op" the route's own header says an explicit staff action must never
  // produce. `.select('id')` + a zero-rows check resolves a lost race to the
  // same 409 'locked' shape the pre-check above returns.
  const { data: updatedRows, error: updateErr } = await sb
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
        staffSet: { by: operator?.email ?? null, at: new Date().toISOString() },
      },
      browsing_selection_updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .is('customer_approved_at', null)
    .select('id');
  if (updateErr) {
    console.error('[api/quotes/:id/staff-selection] update failed:', updateErr);
    return NextResponse.json({ error: `Failed to save selection: ${updateErr.message}` }, { status: 500 });
  }

  if (!updatedRows || updatedRows.length === 0) {
    return NextResponse.json(
      {
        error: "This quote is already approved — the frozen order can't be pre-selected. Use Amend instead.",
        code: 'locked',
      },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true });
}
