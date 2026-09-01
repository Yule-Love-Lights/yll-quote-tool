// POST /api/referrals/pending-lookup — operator-gated. Given the phone and/or
// email of the person a quote is being built for, answer "did this lead come
// in through somebody's referral link?" so the quote builder can offer to set
// "Referred by" instead of depending on a staffer remembering.
//
// Why this route exists: `accrueOnBooking` only ever matches on
// `referee_quote_id`, which is set solely when staff pick a referrer in the
// builder, before the deposit is taken. Miss that moment and the referrer's
// $125 cannot be paid without a developer editing the database. The 'link'
// row the friend created at /refer/<code> was never read back by anything.
//
// POST, not GET, deliberately: the body carries a real person's phone and
// email, and a GET would put both in the URL, the Vercel request log, and the
// browser history. Nothing here mutates.
//
// NOT added to operatorGate's allowlist, and it must not be: `isPublicPath`
// default-denies every path it does not list, which is exactly the behaviour
// this route wants. Adding it there would expose a lead-lookup endpoint to
// anonymous callers.

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { findPendingLinkReferralForContact } from '@/lib/referrals';

export const runtime = 'nodejs';

const MAX_FIELD_LEN = 200;

function clean(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim().slice(0, MAX_FIELD_LEN);
  return t.length ? t : null;
}

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
  }

  const { phone, email, excludeCustomerId } = body as Record<string, unknown>;
  const cleanPhone = clean(phone);
  const cleanEmail = clean(email);

  // Nothing to match on is a normal state (a walk-in quote with no contact
  // details typed yet), not an error. Answer "no referral" and let the
  // builder stay quiet.
  if (!cleanPhone && !cleanEmail) {
    return NextResponse.json({ match: null });
  }

  const match = await findPendingLinkReferralForContact({
    phone: cleanPhone,
    email: cleanEmail,
    excludeCustomerId: clean(excludeCustomerId),
  });

  return NextResponse.json({ match });
}
