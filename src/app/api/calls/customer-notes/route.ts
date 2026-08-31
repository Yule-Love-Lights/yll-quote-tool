// GET /api/calls/customer-notes?hlContactId=<id> — one customer's call
// summaries + tasks, over HTTP (Naldo's ask, 2026-08-31). Same content and
// shape as getCallNotesForCustomer, which the /customers/[contactId] page
// already calls directly as a server component; this route exists so the
// quote builder's call-notes drawer (a CLIENT component, QuoteBuilder.tsx)
// can reach the same data without turning the builder into a server
// component or duplicating the query.
//
// Operator-gated, same as every other admin-surface route.
//
// FIX ROUND (technical-lens review):
//
// 1. Resolves EVERY HighLevel contact id this customer's quotes have ever
//    carried, not just the one this quote happens to hold. This is the same
//    single-id gap the admin lens on #1131 caught for CustomerCallNotesPanel
//    (the /customers/[contactId] server component) -- a customer whose HL
//    contact id changed across quotes (a merge, a re-match) would otherwise
//    show an incomplete history here even though the page shows all of it.
//    Mirrors that page's own resolution (every distinct highlevel_contact_id
//    across the customer's quotes), just derived server-side from ONE known
//    id instead of client-side from an already-fetched quotes array, since
//    this route only ever receives the one id the builder currently holds.
//
// 2. A genuine backend failure (Supabase down, a real query error) now
//    returns a non-2xx status instead of a 200 with an empty list. Before
//    this fix, an outage and "this customer genuinely has no calls" were
//    indistinguishable to the caller -- a rep could read a real outage as
//    confirmed silence. The client-side drawer already has an error path
//    (a fetch that isn't `res.ok` sets loadError); it simply never had a
//    non-200 response to trigger it.

import { NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getCallNotesForCustomer } from '@/lib/calls/customerCallNotes';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';

export const runtime = 'nodejs';

/**
 * Every HighLevel contact id this customer's quotes have ever carried,
 * given just one of them. Falls back to [hlContactId] alone when no quote
 * (and so no customer_id) can be resolved -- the same fallback the
 * /customers/[contactId] page uses for a brand-new, not-yet-linked contact.
 */
async function resolveAllContactIds(hlContactId: string): Promise<string[]> {
  if (!isSupabaseServiceConfigured()) return [hlContactId];
  const sb = getSupabaseServiceClient()!;

  const { data: anchor, error: anchorError } = await sb
    .from('quotes')
    .select('customer_id')
    .eq('highlevel_contact_id', hlContactId)
    .not('customer_id', 'is', null)
    .limit(1)
    .maybeSingle();
  if (anchorError) throw anchorError;

  const customerId = (anchor as { customer_id: string | null } | null)?.customer_id;
  if (!customerId) return [hlContactId];

  const { data: rows, error: rowsError } = await sb
    .from('quotes')
    .select('highlevel_contact_id')
    .eq('customer_id', customerId)
    .not('highlevel_contact_id', 'is', null);
  if (rowsError) throw rowsError;

  const ids = new Set<string>([hlContactId]);
  for (const row of (rows ?? []) as { highlevel_contact_id: string | null }[]) {
    if (row.highlevel_contact_id) ids.add(row.highlevel_contact_id);
  }
  return [...ids];
}

export async function GET(req: Request) {
  const denied = await requireOperator();
  if (denied) return denied;

  const url = new URL(req.url);
  const hlContactId = url.searchParams.get('hlContactId')?.trim();
  if (!hlContactId) {
    return NextResponse.json({ calls: [] });
  }

  try {
    const contactIds = await resolveAllContactIds(hlContactId);
    const calls = await getCallNotesForCustomer(contactIds);
    return NextResponse.json({ calls });
  } catch (err) {
    console.error('GET /api/calls/customer-notes failed:', err);
    return NextResponse.json({ error: 'Could not load call notes.' }, { status: 500 });
  }
}
