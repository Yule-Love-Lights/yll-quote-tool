// GET /api/customers?q=<search> — operator-gated customer search, used by the
// quote builder's "Referred by" typeahead (ledger #41). The referrer for a
// referral must be an EXISTING customer (i.e. someone with a booking history
// already in our own customers table), not a HighLevel lookup — this is
// intentionally a different search surface than HighLevelContactAutocomplete.
//
// Returns up to 10 matches by name/email/phone (case-insensitive substring),
// narrowest first. Empty/short queries return an empty list rather than the
// whole table.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

const MIN_QUERY_LEN = 2;
const MAX_RESULTS = 10;

// A value is safe to interpolate into a PostgREST .or() filter only if it
// can't contain a comma/paren that would inject extra filter clauses — mirrors
// the same guard in src/lib/customers.ts (customers-or-sanitize).
function safeOrValue(v: string): boolean {
  return !v.includes(',') && !v.includes('(') && !v.includes(')');
}

export async function GET(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < MIN_QUERY_LEN || !safeOrValue(q)) {
    return NextResponse.json({ customers: [] });
  }

  const sb = getSupabaseServiceClient()!;
  const { data, error } = await sb
    .from('customers')
    .select('id, name, email, phone')
    .or(`name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`)
    .order('updated_at', { ascending: false })
    .limit(MAX_RESULTS);

  if (error) {
    console.error('[api/customers] search failed:', error);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }

  return NextResponse.json({ customers: data ?? [] });
}
