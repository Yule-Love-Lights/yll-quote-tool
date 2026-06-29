// Claim / release a contact in the shared queue (#58 Phase 1.5). Operator-gated.
// Claiming sets dashboard_contacts.assigned_to so the team sees who's handling a
// customer ("I've got this") — it does NOT force assignment; items stay grabbable.
// Requires a real operator session (assigned_to is an auth.users FK), so it's a
// no-op until auth is live.

import { NextRequest, NextResponse } from 'next/server';
import { getOperator, requireOperator } from '@/lib/auth/supabaseServer';
import { rateLimitResponse } from '@/lib/rateLimit';
import { claimContact, releaseContact } from '@/lib/dashboard/inbox/store';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  const rl = rateLimitResponse(req, { bucket: 'dashboard-claim', limit: 60, windowMs: 60_000 });
  if (rl) return rl;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { contactId, action } = body as { contactId?: unknown; action?: unknown };
  if (typeof contactId !== 'string' || !contactId) {
    return NextResponse.json({ error: 'contactId required' }, { status: 400 });
  }
  if (action !== 'claim' && action !== 'release') {
    return NextResponse.json({ error: "action must be 'claim' or 'release'" }, { status: 400 });
  }

  const operator = await getOperator();
  if (!operator?.id) return NextResponse.json({ error: 'Sign-in required to claim' }, { status: 401 });

  const res =
    action === 'claim' ? await claimContact(contactId, operator.id) : await releaseContact(contactId, operator.id);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: 503 });
  return NextResponse.json({ ok: true });
}
