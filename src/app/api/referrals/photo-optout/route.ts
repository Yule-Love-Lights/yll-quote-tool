// POST /api/referrals/photo-optout — operator-gated staff toggle for the
// PR-1-promised photo opt-out switch (ledger #41). Body: { customerId, optout }.
//
// `optout` is the STORED flag (customers.referral_photo_optout): true means
// the customer's own house photo is hidden from their /refer/<code> page.
// The customer profile panel's checkbox is labeled the positive way ("Use
// their house photo…") and inverts it client-side before calling this route
// — this route only owns the DB write, not the label polarity.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { setReferralPhotoOptout } from '@/lib/referrals';

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

  const { customerId, optout } = body;
  if (typeof customerId !== 'string' || !UUID_RE.test(customerId)) {
    return NextResponse.json({ error: 'customerId must be a valid UUID' }, { status: 400 });
  }
  if (typeof optout !== 'boolean') {
    return NextResponse.json({ error: 'optout must be a boolean' }, { status: 400 });
  }

  const ok = await setReferralPhotoOptout(customerId, optout);
  if (!ok) {
    return NextResponse.json({ error: 'Failed to save the photo opt-out setting' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, optout });
}
