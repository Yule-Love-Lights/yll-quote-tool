// POST /api/invoices/[id]/mark-paid  (operator-only)
//
// Operator records an offline/external payment (cash / check / paid in the
// Valor terminal). Calls markInvoicePaidManually which atomically sets
// status='paid', balance=0, paid_at=now (.neq('status','paid') claim) so
// a double-click can't double-settle. Idempotent on an already-paid invoice.
// After the settle, close the linked job (requires_invoicing → done) so the
// pipeline mirrors the Valor balance webhook (which closes the job on balance
// settle). markInvoicePaidManually itself never touches the job, so the route
// does the close best-effort — a job-close failure never fails the payment.
//
// Response: { ok, paid, invoice: { id, status, balance } }

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { markInvoicePaidManually } from '@/lib/invoices';
import { getJob, setJobStatus } from '@/lib/jobs';

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

  // Close the linked job once payment is collected (best-effort — the payment is
  // already recorded, so a job-close failure must never fail the request). This
  // mirrors the Valor balance-settle path in the webhook: requires_invoicing → done.
  // markInvoicePaidManually returns the full invoice row (incl. job_id) on every
  // branch, so no extra read is needed to find the job.
  try {
    if (invoice.job_id) {
      const job = await getJob(invoice.job_id);
      if (job && job.status === 'requires_invoicing') {
        await setJobStatus(job.id, 'done');
      }
    }
  } catch (err) {
    console.error('[api/invoices/:id/mark-paid] job close failed:', err);
  }

  return NextResponse.json({
    ok: true,
    paid: true,
    invoice: { id: invoice.id, status: invoice.status, balance: invoice.balance },
  });
}
