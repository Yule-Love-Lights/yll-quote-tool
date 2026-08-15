// GET /api/customers?q=<search> — operator-gated customer search, used by the
// quote builder's "Referred by" typeahead (ledger #41). The referrer for a
// referral must be an EXISTING customer (i.e. someone with a booking history
// already in our own customers table), not a HighLevel lookup — this is
// intentionally a different search surface than HighLevelContactAutocomplete.
//
// Returns up to 10 matches by name/email/phone (case-insensitive substring),
// narrowest first. Empty/short queries return an empty list rather than the
// whole table.
//
// GET /api/customers?id=<uuid> — redemption (PR 2): a single-customer lookup
// by id, same response shape, used by the quote builder's credit banner to
// resolve ONE known customer (the quote's linked customer_id) rather than a
// name/email/phone search.
//
// GET /api/customers?hlContactId=<id> — tag inheritance (#198): a single-
// customer lookup by hl_contact_id, same response shape, used by the quote
// builder's HL-contact-pick flow to check whether the just-picked contact
// maps to an already-tagged customer (so the builder's NCE/Neighbor chips can
// turn on to match). Read-only — never creates a row.
//
// All three branches attach `referralCreditUsd` (creditBalanceFor) and the
// NCE/Neighbor tags to each row so callers don't need a second round trip.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { creditBalanceFor } from '@/lib/referrals';

export const runtime = 'nodejs';

const MIN_QUERY_LEN = 2;
const MAX_RESULTS = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A value is safe to interpolate into a PostgREST .or() filter only if it
// can't contain a comma/paren that would inject extra filter clauses — mirrors
// the same guard in src/lib/customers.ts (customers-or-sanitize).
function safeOrValue(v: string): boolean {
  return !v.includes(',') && !v.includes('(') && !v.includes(')');
}

type CustomerRow = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  // NCE + YLL Neighbor tags (#198).
  is_nce: boolean;
  is_yll_neighbor: boolean;
};

const CUSTOMER_COLUMNS = 'id, name, email, phone, is_nce, is_yll_neighbor';

// Referral program redemption (#41 PR 2): attach each row's spendable
// referral credit balance. Capped at MAX_RESULTS (10) rows, so this is at
// most 10 extra point queries — the simplest correct thing for a low-volume
// operator-only search, not worth a join.
async function withCredit(rows: CustomerRow[]): Promise<(CustomerRow & { referralCreditUsd: number })[]> {
  return Promise.all(rows.map(async (r) => ({ ...r, referralCreditUsd: await creditBalanceFor(r.id) })));
}

export async function GET(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const sb = getSupabaseServiceClient()!;

  // Single-customer lookup (redemption, PR 2) — a completely different access
  // pattern from the typeahead search below (one known id, not a substring
  // match), so it's a separate branch rather than treating id as a q= value.
  const id = req.nextUrl.searchParams.get('id')?.trim();
  if (id) {
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ customers: [] });
    }
    const { data, error } = await sb
      .from('customers')
      .select(CUSTOMER_COLUMNS)
      .eq('id', id)
      .maybeSingle<CustomerRow>();
    if (error || !data) {
      return NextResponse.json({ customers: [] });
    }
    return NextResponse.json({ customers: await withCredit([data]) });
  }

  // Single-customer lookup by HighLevel contact id (tag inheritance, #198) —
  // same shape as the id branch above, just keyed on hl_contact_id instead.
  // Read-only: never creates a row (mirrors getCustomerByHlContactId in
  // src/lib/customers.ts, which server components call directly for the same
  // purpose — this branch exists for the CLIENT-side pick flow instead).
  const hlContactId = req.nextUrl.searchParams.get('hlContactId')?.trim();
  if (hlContactId) {
    const { data, error } = await sb
      .from('customers')
      .select(CUSTOMER_COLUMNS)
      .eq('hl_contact_id', hlContactId)
      .maybeSingle<CustomerRow>();
    if (error || !data) {
      return NextResponse.json({ customers: [] });
    }
    return NextResponse.json({ customers: await withCredit([data]) });
  }

  const q = req.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (q.length < MIN_QUERY_LEN || !safeOrValue(q)) {
    return NextResponse.json({ customers: [] });
  }

  const { data, error } = await sb
    .from('customers')
    .select(CUSTOMER_COLUMNS)
    .or(`name.ilike.%${q}%,email.ilike.%${q}%,phone.ilike.%${q}%`)
    .order('updated_at', { ascending: false })
    .limit(MAX_RESULTS);

  if (error) {
    console.error('[api/customers] search failed:', error);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }

  return NextResponse.json({ customers: await withCredit((data ?? []) as CustomerRow[]) });
}
