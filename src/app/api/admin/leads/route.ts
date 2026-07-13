// GET /api/admin/leads — operator-facing list of website lead-capture rows
// (#leads visibility + GHL-outage recovery). Strict requireAdmin() like the rest
// of the /api/admin/* namespace: lead rows carry customer PII and the sibling
// manual-retry route fires GHL writes, so this is an admin data surface, not
// routine operator traffic. The row is always the source of truth; this view
// (plus /api/admin/leads/[id]/retry) is how a human sees + recovers rows the
// automatic cron retry hasn't cleared.

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';

export const runtime = 'nodejs';

// Lean projection for the admin table — everything a human needs to triage a
// stuck lead, minus the fields that aren't useful here (consent/ip/utm/landing).
const LEAD_LIST_COLUMNS =
  'id,created_at,service,form_variant,name,email,phone,address,notes,sync_status,sync_error,retry_count,last_retried_at,ghl_contact_id,ghl_opportunity_id,is_test';

// The actionable default: rows a human might still need to act on. 'synced' is
// done and 'spam'/'rate_limited' aren't recovery targets, so they're excluded
// unless explicitly requested via ?status=.
const STUCK_STATUSES = ['pending', 'deferred', 'failed'];

const MAX_ROWS = 500;

export async function GET(req: NextRequest) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const status = req.nextUrl.searchParams.get('status') ?? 'stuck';
  let query = sb
    .from('website_leads')
    .select(LEAD_LIST_COLUMNS)
    .order('created_at', { ascending: false })
    .limit(MAX_ROWS);
  if (status === 'stuck') query = query.in('sync_status', STUCK_STATUSES);
  else if (status !== 'all') query = query.eq('sync_status', status);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ leads: data ?? [], status });
}
