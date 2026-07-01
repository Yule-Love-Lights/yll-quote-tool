// POST /api/invoices/[id]/mark-paid  (operator-only)
//
// Operator records an offline/external payment (cash / check / paid in the
// Valor terminal). Calls markInvoicePaidManually which atomically sets
// status='paid', balance=0, paid_at=now (.neq('status','paid') claim) so
// a double-click can't double-settle. Idempotent on an already-paid invoice.
// Does NOT touch the job — use /api/jobs/[id]/close to finalize the job.
//
// Response: { ok, paid, invoice: { id, status, balance } }

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { markInvoicePaidManually } from '@/lib/invoices';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid invoice id' }, { status: 400 });
  }

  let invoice;
  try {
    invoice = await markInvoicePaidManually(id);
  } catch (err) {
    console.error('[api/invoices/:id/mark-paid]', err);
    return NextResponse.json(
      { error: 'Invoice cannot be marked paid', code: 'cancelled' },
      { status: 409 },
    );
  }

  if (!invoice) {
    return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    paid: true,
    invoice: { id: invoice.id, status: invoice.status, balance: invoice.balance },
  });
}
