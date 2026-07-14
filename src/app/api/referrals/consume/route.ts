// POST /api/referrals/consume — operator-gated referral credit redemption
// (ledger #41 PR 2). Body: { customerId, quoteId }.
//
// Spends the referrer's ENTIRE currently-'booked' credit balance in one shot
// (see consumeCredits in src/lib/referrals.ts for the locked, simplified
// whole-balance trade — a credit is a whole $125 unit, never partial, so
// applying it consumes every unspent row for that referrer regardless of
// whether the quote is cheaper than the balance). The applied discount
// amount is computed SERVER-SIDE from the quote's own stored subtotal
// (result.subtotalBeforeDiscount) — never trust a client-supplied dollar
// figure for a money mutation. The quote builder still sets the discount
// slot itself (type:'flat', amount = appliedUsd) using the value this route
// returns; this route only owns the DB-side consumption + the amount math.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getQuoteRaw } from '@/lib/quotes';
import { creditBalanceFor, consumeCredits } from '@/lib/referrals';

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
  // #41 adversarial-review LOW fix: reject a mismatched customer/quote pair
  // or a test quote BEFORE touching the balance or consuming anything — a
  // stale/mistaken pairing must never apply one customer's credit as a
  // discount on a DIFFERENT customer's quote, and test quotes must never
  // touch the real referral ledger.
  if (quote.customer_id !== customerId) {
    return NextResponse.json({ error: 'This quote is not linked to that customer' }, { status: 400 });
  }
  if (quote.is_test) {
    return NextResponse.json({ error: 'Test quotes cannot redeem referral credit' }, { status: 400 });
  }

  const balance = await creditBalanceFor(customerId);
  if (balance <= 0) {
    return NextResponse.json(
      { error: 'No referral credit available for this customer', code: 'no-credit' },
      { status: 409 },
    );
  }

  // Never trust a client-supplied amount for a money mutation — derive the
  // applied discount from the quote's own stored subtotal.
  const subtotal = quote.result?.subtotalBeforeDiscount ?? 0;
  const appliedUsd = Math.min(balance, subtotal);
  if (appliedUsd <= 0) {
    return NextResponse.json(
      { error: 'This quote has no subtotal to discount yet. Calculate first.', code: 'no-subtotal' },
      { status: 409 },
    );
  }

  const result = await consumeCredits(customerId, quoteId, appliedUsd);
  if (!result.consumed) {
    return NextResponse.json(
      { error: 'Credit unavailable (already applied, or a concurrent request just consumed it)', code: 'no-credit' },
      { status: 409 },
    );
  }

  // The billed discount derives from what the claim ACTUALLY consumed, not
  // the pre-claim balance read (#41 expiry): a row expiring between the two
  // shrinks the claim, and returning the stale figure would bill a discount
  // bigger than the credit spent. min(consumedUsd, subtotal) equals the old
  // min(balance, subtotal) whenever nothing raced.
  const finalAppliedUsd = Math.min(result.consumedUsd, subtotal);

  return NextResponse.json({
    ok: true,
    appliedUsd: finalAppliedUsd,
    consumedRowIds: result.consumedRowIds,
    balanceUsd: result.newBalanceUsd,
  });
}
