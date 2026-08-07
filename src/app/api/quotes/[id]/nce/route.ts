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
// removes an untouched 40 (reverting to blank/50%); any other value is left
// alone. Best-effort, like propagation below — a write failure never fails
// the toggle itself.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { attachQuoteToCustomer, propagateQuoteTagsToCustomer, quoteRowToIdentity } from '@/lib/customers';

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
  const { data, error } = await sb
    .from('quotes')
    .update({ is_nce: isNce })
    .eq('id', id)
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
      const { depositPercent: _drop, ...rest } = inputs;
      void _drop; // mirrors apply-color-request/route.ts's same destructure-drop idiom
      depositWrite = rest;
    }
    if (depositWrite) {
      const { error: depErr } = await sb.from('quotes').update({ inputs: depositWrite }).eq('id', id);
      if (depErr) {
        console.warn('[api/quotes/:id/nce] #199 deposit-default write failed (non-fatal):', depErr);
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
