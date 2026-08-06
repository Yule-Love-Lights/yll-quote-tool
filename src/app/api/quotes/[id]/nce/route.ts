// Staff-only "Mark as NCE" toggle (#198), mirroring the legacy-rebook route's
// shape exactly (same admin quote detail page, same operator gate, same
// update/select/response pattern).
//
// POST /api/quotes/[id]/nce   (operator-only)
// Body: { isNce: boolean }   — strict: must be a real boolean.
// Response: { ok: true, isNce: boolean } | { error, code? }
//
// NCE = the barter/trade network YLL belongs to. Unlike legacy_rebook, this
// tag currently drives NO real tool behavior on its own — no inbox exclusion,
// no portal variant, no GHL pipeline change. It's storage + visibility only
// (#198); the money behaviors (40% deposit default, balance-collection
// blocks, invoice mark-paid-NCE) are ledger #199, layered on top of this tag
// later.
//
// Tag propagation (#198): when this quote is ALREADY SENT and linked to a
// customers row, turning the tag ON propagates it onto that customer
// immediately (mirrors updateQuote's builder-save propagation — the same
// rule regardless of which UI set the tag). Forward-only: turning the tag
// OFF never untags the customer. Best-effort: a propagation failure never
// fails the toggle itself.

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
      'id, is_nce, quote_sent_at, customer_id, is_test, highlevel_contact_id, customer_name, customer_email, customer_phone, customer_address',
    )
    .maybeSingle<{
      id: string;
      is_nce: boolean;
      quote_sent_at: string | null;
      customer_id: string | null;
      is_test: boolean;
      highlevel_contact_id: string | null;
      customer_name: string | null;
      customer_email: string | null;
      customer_phone: string | null;
      customer_address: string | null;
    }>();

  if (error) {
    console.error('[api/quotes/:id/nce] update failed:', error);
    return NextResponse.json({ error: 'Failed to update the quote' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  // #214 (verify-or-reattach): re-resolve the customers link before
  // propagating instead of trusting the cached customer_id — an identity
  // edit since the last resolution can leave it pointing at the WRONG
  // customer, and this admin toggle is exactly the kind of late tag flip
  // the S34 wrap review traced onto stale links. Attach-first with the
  // cached id as fallback, same shape as /send + /mark-sent; also lifts the
  // old customer_id-non-null gate, so tagging a never-linked sent quote now
  // heals the link instead of silently skipping (mirrors the send route's
  // lazy attach). Only runs when propagation would actually fire — a
  // toggle-OFF or an un-sent quote pays no extra round trips.
  if (!data.is_test && isNce && data.quote_sent_at) {
    try {
      const linkedCustomerId =
        (await attachQuoteToCustomer(quoteRowToIdentity(data)))?.customerId ??
        data.customer_id ??
        null;
      if (linkedCustomerId) {
        await propagateQuoteTagsToCustomer(linkedCustomerId, { isNce: true });
      }
    } catch (err) {
      console.warn('[api/quotes/:id/nce] tag propagation failed (non-fatal):', err);
    }
  }

  return NextResponse.json({ ok: true, isNce: data.is_nce });
}
