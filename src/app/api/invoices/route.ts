import { NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { listInvoicesForAdmin } from '@/lib/invoices';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

// Operator-only billing list of invoices (ledger #83). Service-role only (reads
// under RLS). Gated by the #81 perimeter; also calls requireOperator() as defense
// in depth — dormant until AUTH_GATE_ENABLED.
export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json({ invoices: await listInvoicesForAdmin() });
  } catch (err) {
    console.error('[api/invoices] GET failed:', err);
    return NextResponse.json({ error: 'Failed to load invoices' }, { status: 500 });
  }
}
