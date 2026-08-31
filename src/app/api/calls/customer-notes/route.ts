// GET /api/calls/customer-notes?hlContactId=<id> — one customer's call
// summaries + tasks, over HTTP (Naldo's ask, 2026-08-31). Same content and
// shape as getCallNotesForCustomer, which the /customers/[contactId] page
// already calls directly as a server component; this route exists so the
// quote builder's call-notes drawer (a CLIENT component, QuoteBuilder.tsx)
// can reach the same data without turning the builder into a server
// component or duplicating the query.
//
// Operator-gated, same as every other admin-surface route. Degrades to an
// empty list rather than a 500 on any failure: a call-notes drawer that
// cannot load is a missing convenience, never a reason to block editing a
// quote.

import { NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getCallNotesForCustomer } from '@/lib/calls/customerCallNotes';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const denied = await requireOperator();
  if (denied) return denied;

  const url = new URL(req.url);
  const hlContactId = url.searchParams.get('hlContactId')?.trim();
  if (!hlContactId) {
    return NextResponse.json({ calls: [] });
  }

  try {
    const calls = await getCallNotesForCustomer([hlContactId]);
    return NextResponse.json({ calls });
  } catch (err) {
    console.error('GET /api/calls/customer-notes failed:', err);
    return NextResponse.json({ calls: [] });
  }
}
