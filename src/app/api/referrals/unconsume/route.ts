// POST /api/referrals/unconsume — operator-gated "Remove referral credit"
// (ledger #41 adversarial-review MED fix). Body: { customerId, quoteId }.
// The counterpart to /api/referrals/consume: flips this quote's CREDITED
// referral rows back to 'booked' (clearing credited_at/credited_quote_id),
// so the balance becomes spendable again elsewhere. Called by the quote
// builder's referral-credit banner when staff click Remove, right before it
// clears the quote's discount fields and re-persists via the normal
// Calculate path (see ReferralCreditBanner.tsx / QuoteBuilder.tsx).
//
// Same money-safety validation as consume: reject a mismatched customer/quote
// pair or a test quote BEFORE mutating anything. Idempotent (releaseCredits'
// own conditional claim) — a repeat call that finds nothing left to release
// still 200s; there's nothing wrong with "already removed".

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getQuoteRaw } from '@/lib/quotes';
import { releaseCredits } from '@/lib/referrals';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { customerId, quoteId } = body;
  if (typeof customerId !== 'string' || !UUID_RE.test(customerId)) {
    return NextResponse.json({ error: 'customerId must be a valid UUID' }, { status: 400 });
  }
  if (typeof quoteId !== 'string' || !UUID_RE.test(quoteId)) {
    return NextResponse.json({ error: 'quoteId must be a valid UUID' }, { status: 400 });
  }

  const quote = await getQuoteRaw(quoteId);
  if (!quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }
  // Same guard as /api/referrals/consume: reject a mismatched customer/quote
  // pair or a test quote before mutating anything.
  if (quote.customer_id !== customerId) {
    return NextResponse.json({ error: 'This quote is not linked to that customer' }, { status: 400 });
  }
  if (quote.is_test) {
    return NextResponse.json({ error: 'Test quotes cannot release referral credit' }, { status: 400 });
  }

  const result = await releaseCredits(customerId, quoteId);
  return NextResponse.json({
    ok: true,
    released: result.released,
    releasedRowIds: result.releasedRowIds,
    releasedUsd: result.releasedUsd,
  });
}
