// POST /api/admin/leads/[id]/retry — an operator's manual re-drive of one stuck
// website-lead row from /admin/leads (the recovery lever when the automatic cron
// retry hasn't cleared a row, or has parked it 'failed'). Strict requireAdmin().
// Bypasses the cron's batch query so an already-'failed' row can still be re-tried
// by hand; retryOneLead handles the idempotent re-drive + write-back.

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/supabaseServer';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { retryOneLead } from '@/lib/leads/leadRetry';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if ('response' in auth) return auth.response;

  const sb = getSupabaseServiceClient();
  if (!sb) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'Lead not found' }, { status: 404 });

  const { data: row, error } = await sb
    .from('website_leads')
    .select('*')
    .eq('id', id)
    .maybeSingle<Record<string, unknown>>();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: 'Lead not found' }, { status: 404 });

  // spam never syncs; synced is already done — neither is a retry target.
  if (row.sync_status === 'spam') {
    return NextResponse.json({ error: 'Spam rows are not retriable' }, { status: 400 });
  }
  if (row.sync_status === 'synced') {
    return NextResponse.json({ error: 'Lead is already synced' }, { status: 400 });
  }

  const outcome = await retryOneLead(row, { now: new Date() });
  return NextResponse.json({ ok: true, id, outcome });
}
