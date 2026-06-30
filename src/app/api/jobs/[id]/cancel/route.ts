// Cancel a booked order (ledger #83 — SPEC §2 Cancellations). OPERATOR-ONLY.
//
// POST /api/jobs/[id]/cancel
// Sets the job → cancelled, its linked invoice → cancelled (if any), and the
// source quote → cancelled. REFUNDS ARE MANUAL IN VALOR (the locked decision —
// no refund integration); the response says so. A `done` job (fully complete +
// paid) can't be cancelled.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getJob, setJobStatus } from '@/lib/jobs';
import { getInvoiceByJob, setInvoiceStatus } from '@/lib/invoices';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });
  }

  const job = await getJob(id);
  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }
  if (job.status === 'cancelled') {
    return NextResponse.json({ ok: true, alreadyCancelled: true });
  }
  if (job.status === 'done') {
    return NextResponse.json(
      { error: 'A completed job cannot be cancelled', code: 'job-done' },
      { status: 409 },
    );
  }

  // Cancel the job (legal from any non-terminal billing status).
  try {
    await setJobStatus(id, 'cancelled');
  } catch (err) {
    console.error('[api/jobs/:id/cancel] job cancel failed:', err);
    return NextResponse.json({ error: 'Could not cancel the job' }, { status: 409 });
  }

  // Cancel the linked invoice if one exists (cancel is legal from any non-cancelled
  // invoice status, including paid → a paid-then-cancelled invoice means a MANUAL
  // Valor refund). Best-effort: the job is already cancelled.
  const invoice = await getInvoiceByJob(id);
  if (invoice && invoice.status !== 'cancelled') {
    try {
      await setInvoiceStatus(invoice.id, 'cancelled');
    } catch (err) {
      console.error('[api/jobs/:id/cancel] invoice cancel failed:', err);
    }
  }

  // Cancel the source quote too (operator-initiated; written directly via the
  // service-role client — a deliberate booking cancellation). Read its deposit
  // state FIRST so we can flag a deposit refund even when no invoice exists yet —
  // a booked-but-not-completed order still took a 50% deposit (review MEDIUM).
  let refundedDeposit = false;
  if (job.quote_id) {
    const sb = getSupabaseServiceClient()!;
    const { data: q } = await sb
      .from('quotes')
      .select('deposit_paid_at')
      .eq('id', job.quote_id)
      .maybeSingle<{ deposit_paid_at: string | null }>();
    refundedDeposit = !!q?.deposit_paid_at;
    const { error } = await sb.from('quotes').update({ status: 'cancelled' }).eq('id', job.quote_id);
    if (error) console.error('[api/jobs/:id/cancel] quote cancel failed:', error);
  }

  const refundedInvoice = !!(invoice && invoice.status === 'paid');
  const refundNeeded = refundedInvoice || refundedDeposit;
  return NextResponse.json({
    ok: true,
    cancelled: true,
    refundedInvoice,
    refundedDeposit,
    refundNeeded,
    note: refundNeeded
      ? 'A payment was already taken — issue the refund manually in Valor.'
      : 'No payment was taken — nothing to refund.',
  });
}
