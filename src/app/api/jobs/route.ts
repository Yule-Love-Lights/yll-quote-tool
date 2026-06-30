import { NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { listJobsForAdmin } from '@/lib/jobs';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

// Operator-only BILLING list of jobs (ledger #83). The fulfillment Kanban (#82)
// is a separate OPS view of the SAME rows at /api/inventory/jobs; this is the
// billing view (status, customer, From-Quote). Service-role only (reads under
// RLS). Gated by the #81 session perimeter; also calls requireOperator() as
// defense in depth — dormant until AUTH_GATE_ENABLED, so the same-origin
// /admin/jobs fetch keeps working and rides the operator session once live.
export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json({ jobs: await listJobsForAdmin() });
  } catch (err) {
    console.error('[api/jobs] GET failed:', err);
    return NextResponse.json({ error: 'Failed to load jobs' }, { status: 500 });
  }
}
