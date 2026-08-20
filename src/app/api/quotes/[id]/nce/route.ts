// Staff-only "Mark as NCE" toggle (#198), mirroring the legacy-rebook route's
// shape exactly (same admin quote detail page, same operator gate, same
// update/select/response pattern).
//
// POST /api/quotes/[id]/nce   (operator-only)
// Body: { isNce: boolean }   — strict: must be a real boolean.
// Response: { ok: true, isNce: boolean } | { error, code? }
//
// NCE = the barter/trade network YLL belongs to. Unlike legacy_rebook, this
// tag drives no inbox exclusion, portal variant, or GHL pipeline change — it's
// storage + visibility (#198), plus the #199 40% deposit default below (the
// OTHER #199 money behaviors — balance-collection blocks, invoice
// mark-paid-NCE — live on their own routes, not here).
//
// Tag propagation (#198): when this quote is ALREADY SENT and linked to a
// customers row, turning the tag ON propagates it onto that customer
// immediately (mirrors updateQuote's builder-save propagation — the same
// rule regardless of which UI set the tag). Forward-only: turning the tag
// OFF never untags the customer. Best-effort: a propagation failure never
// fails the toggle itself.
//
// NCE 40% deposit default (#199): pre-approval only (customer_approved_at
// null — the #177 freeze owns an approved/booked quote's deposit). Turning ON
// writes inputs.depositPercent=40 ONLY when the quote has no existing
// override (absent or 0) — unlike the builder chip (applyIsNce, which
// force-sets 40 unconditionally on every turn-on), this route NEVER
// overwrites a value staff already hand-set, because it fires on quotes the
// operator isn't actively editing in the builder right now. Turning OFF
// resets an untouched 40 to an explicit depositPercent=0 (reverting to the
// 50% default via effectiveDepositRate — see #226 below); any other value is
// left alone. Best-effort, like propagation below — a write failure never
// fails the toggle itself.
//
// #226 (adversarial-review HIGH, live-prod bug): turning OFF used to DELETE
// the depositPercent key instead of writing 0. That left downstream callers
// passing `undefined` depositPercent into chargesFromResult, which falls
// through to a possibly-STALE `result.depositRate` frozen the last time
// Calculate ran — still 0.4 if that happened while NCE was ON. An explicit 0
// resolves through effectiveDepositRate to the 50% default correctly (0 is
// out of its [1,100] range), matching the builder chip's own OFF behavior
// (resolveNceDepositPercent in quoteForm.ts already returns 0, not undefined).
//
// #243 (domain rule locked 2026-08-11): permanent/event/bistro quotes can
// never carry the NCE tag — canCarryNceOrYllNeighborTag (serviceType.ts) is
// the single source of truth every set/inherit site shares. Only the ON
// direction is gated below — turning OFF (including correcting an existing
// violation from before this gate shipped) is always allowed, unconditionally.
// A separate pre-write read, not folded into the update below: the gate must
// run BEFORE any write lands — there's no safe way to "undo" the update once
// it's already committed.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { attachQuoteToCustomer, propagateQuoteTagsToCustomer, quoteRowToIdentity } from '@/lib/customers';
import { canCarryNceOrYllNeighborTag, type ServiceType } from '@/lib/serviceType';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const isNce = (body as { isNce?: unknown } | null)?.isNce;
  if (typeof isNce !== 'boolean') {
    return NextResponse.json(
      { error: 'isNce must be a boolean', code: 'invalid-body' },
      { status: 400 },
    );
  }

  const sb = getSupabaseServiceClient()!;

  // #243: reject turning ON before any write, when the quote's own service
  // type can't carry the tag. A plain read (not a write) — see the header
  // comment above for why this can't be folded into the update below.
  // gateServiceType is hoisted out of this block (fix-round LOW below) so the
  // write can CAS against the EXACT value this gate just approved.
  let gateServiceType: string | null | undefined;
  if (isNce) {
    const { data: gateRow, error: gateError } = await sb
      .from('quotes')
      .select('service_type')
      .eq('id', id)
      .maybeSingle<{ service_type: string | null }>();
    if (gateError) {
      console.error('[api/quotes/:id/nce] service-type read failed:', gateError);
      return NextResponse.json({ error: 'Failed to update the quote' }, { status: 500 });
    }
    if (!gateRow) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
    }
    if (!canCarryNceOrYllNeighborTag(gateRow.service_type as ServiceType | null)) {
      return NextResponse.json(
        {
          error:
            'NCE can only be set on holiday quotes — permanent lighting is always real money, never trade.',
          code: 'not-holiday',
        },
        { status: 400 },
      );
    }
    gateServiceType = gateRow.service_type;
  }

  let updateQuery = sb.from('quotes').update({ is_nce: isNce }).eq('id', id);
  // Fix-round LOW (TOCTOU, two admin toggle routes): the ON-gate above reads
  // service_type, then this write landed unconditionally — a service-type
  // change racing between the read and this write could land is_nce:true on
  // a now-ineligible quote (narrow window, low-concurrency admin tool, but
  // this repo has a recorded TOCTOU/sibling-parity defect class). CAS against
  // the EXACT service_type value the gate just approved — `.is(...)` for the
  // null case since a SQL NULL never matches `.eq('col', null)` (mirrors the
  // inputs-jsonb CAS a few lines down in this same file, and
  // canCarryNceOrYllNeighborTag's own null-is-eligible rule above). Only
  // applied on the ON path — turning OFF is unconditionally allowed
  // regardless of service_type (see the header comment), so there's nothing
  // to guard there.
  if (isNce) {
    updateQuery =
      gateServiceType === null
        ? updateQuery.is('service_type', null)
        : updateQuery.eq('service_type', gateServiceType as string);
  }
  const { data, error } = await updateQuery
    // quote_sent_at + customer_id ridden along so the propagation check below
    // needs no second round trip. is_test ridden along too (review fix, admin
    // MED, S34 #198 review) — defense-in-depth even though staff have no
    // reason to hand-toggle a test quote's tag from this admin-only route;
    // mirrors saveQuote's is_test posture and keeps the invariant even if a
    // future writer breaks the /send + /mark-sent guards. #214: the identity
    // columns ride along too, feeding the verify-or-reattach below.
    .select(
      'id, is_nce, quote_sent_at, customer_id, is_test, deposit_paid_at, highlevel_contact_id, customer_name, customer_email, customer_phone, customer_address, inputs, customer_approved_at',
    )
    .maybeSingle<{
      id: string;
      is_nce: boolean;
      quote_sent_at: string | null;
      customer_id: string | null;
      is_test: boolean;
      deposit_paid_at: string | null;
      highlevel_contact_id: string | null;
      customer_name: string | null;
      customer_email: string | null;
      customer_phone: string | null;
      customer_address: string | null;
      inputs: Record<string, unknown> | null;
      customer_approved_at: string | null;
    }>();

  if (error) {
    console.error('[api/quotes/:id/nce] update failed:', error);
    return NextResponse.json({ error: 'Failed to update the quote' }, { status: 500 });
  }
  if (!data) {
    // The ON-path CAS above can legitimately produce 0 rows for a REASON
    // distinct from "quote not found" — the service type changed between the
    // gate read and this write. No cheap way to tell the two apart without a
    // second round trip on an admin toggle where either is rare; name both
    // possibilities rather than assert "not found" when it might not be true.
    if (isNce) {
      return NextResponse.json(
        {
          error:
            'Could not set NCE — the quote was not found, or its service type changed at the same time. Reload and try again.',
          code: 'gate-race',
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  // #199 40% deposit default — see the header comment for the full rule.
  if (!data.customer_approved_at) {
    const inputs = data.inputs ?? {};
    const currentDepositPercent =
      typeof inputs.depositPercent === 'number' ? inputs.depositPercent : undefined;
    let depositWrite: Record<string, unknown> | null = null;
    if (isNce && (currentDepositPercent === undefined || currentDepositPercent === 0)) {
      depositWrite = { ...inputs, depositPercent: 40 };
    } else if (!isNce && currentDepositPercent === 40) {
      // #226: write an explicit 0, never delete the key — a deleted key
      // reads back as `undefined`, which chargesFromResult treats as "no
      // live value to offer" and falls through to a possibly-stale
      // result.depositRate (still 0.4 if Calculate last ran while NCE was
      // ON). An explicit 0 resolves through effectiveDepositRate to the 50%
      // default correctly.
      depositWrite = { ...inputs, depositPercent: 0 };
    }
    if (depositWrite) {
      // #199 (F3, wrap-review MED-HIGH): this is a read-modify-write of the
      // WHOLE inputs jsonb — un-guarded, a concurrent builder Calculate/save
      // racing this toggle would silently revert the save's entire inputs
      // blob (the closest sibling on this table, free-items/route.ts, CASes
      // for exactly this — mirrored here). CAS against the EXACT inputs we
      // read above; .is() for the null case (a never-priced quote) since a
      // SQL NULL never matches .eq('col','null') (mirrors charge-balance's
      // own null-vs-sentinel CAS split). ALSO re-checks customer_approved_at
      // is STILL null at write time (not just at our read above, seconds
      // earlier) — closes the narrow approve-vs-write TOCTOU where the
      // customer approves in that window, which would otherwise let this
      // pre-approval-only write land on a now-#177-frozen quote. A lost race
      // on EITHER guard skips the write (0 rows) — best-effort, matching this
      // route's existing design (never fails the tag toggle itself).
      let depositUpdateQuery = sb
        .from('quotes')
        .update({ inputs: depositWrite })
        .eq('id', id)
        .is('customer_approved_at', null);
      depositUpdateQuery =
        data.inputs === null
          ? depositUpdateQuery.is('inputs', null)
          : depositUpdateQuery.eq('inputs', JSON.stringify(data.inputs));
      const { data: casRows, error: depErr } = await depositUpdateQuery.select('id');
      if (depErr) {
        console.warn('[api/quotes/:id/nce] #199 deposit-default write failed (non-fatal):', depErr);
      } else if (!casRows || casRows.length === 0) {
        console.warn(
          `[api/quotes/:id/nce] #199 deposit-default write skipped for quote ${id} — inputs or approval state changed concurrently (non-fatal, best-effort)`,
        );
      }
    }
  }

  // #214: propagation target = the CACHED customer_id first, with a
  // re-attach attempt ONLY when the quote was never linked (lifts the old
  // customer_id-non-null gate, so tagging a never-linked sent quote heals
  // the link instead of silently skipping — mirrors the send route's lazy
  // attach; quoteRowToIdentity keeps the row's display sentinels out of the
  // identity). Deliberately NOT attach-first (review fix, admin MED): this
  // toggle legitimately fires on OLD quotes (retroactive tagging is a real
  // workflow), and an unconditional re-resolution would newest-win that old
  // quote's YEAR-OLD stored fields back onto a customer row later quotes
  // kept current. The cache is trustworthy here because updateQuote's own
  // #214 re-attach maintains it at every identity edit AND /send +
  // /mark-sent force a fresh resolution at the quote_sent_at transition
  // this propagation gates on — the write sources verify, the read sites
  // trust. (Delta-verify note: the two identity writers that bypass those —
  // rebook's insert and the self-serve enrich — either copy an
  // already-resolved link or run pre-send, so the invariant holds.)
  if (!data.is_test && isNce && data.quote_sent_at) {
    try {
      // Booked-freeze parity (round-3 delta-verify): the null-link heal
      // never runs on a booked quote either — near-unreachable (send-time
      // resolution gates quote_sent_at), kept for sibling parity with
      // updateQuote + the attach route. Propagation to a non-null cached id
      // is unaffected.
      const linkedCustomerId =
        data.customer_id ??
        (data.deposit_paid_at
          ? null
          : ((await attachQuoteToCustomer(quoteRowToIdentity(data)))?.customerId ?? null));
      if (linkedCustomerId) {
        await propagateQuoteTagsToCustomer(linkedCustomerId, { isNce: true });
      }
    } catch (err) {
      console.warn('[api/quotes/:id/nce] tag propagation failed (non-fatal):', err);
    }
  }

  return NextResponse.json({ ok: true, isNce: data.is_nce });
}
