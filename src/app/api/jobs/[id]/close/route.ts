// POST /api/jobs/[id]/close  (operator-only)
//
// Finalize a job: settle the linked invoice (if unpaid) with an offline/manual
// payment, then advance the job to `done` through the LEGAL jobStatus transitions.
// The invoice settlement reuses markInvoicePaidManually (atomic .neq('status','paid')
// claim — idempotent, no double-settle).
//
// Transition ladder (only through legal steps):
//   to_schedule | scheduled → installed → requires_invoicing → done
//
// A job already `done` is an idempotent no-op (200 { alreadyDone:true }).
// A cancelled job is rejected (400). A job with NO invoice is rejected (409
// no-invoice) — close = finalize + settle, so it must be invoiced first (via
// Complete); closing an un-invoiced job would forfeit the untracked balance.
// A close race (setJobStatus throws because a concurrent request already
// advanced past a step) re-reads: if already `done`, returns success; else 409.
//
// Response: { ok, closed:true } | { ok, alreadyDone:true } | { error, code? }

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getJob, setJobStatus, type JobRow } from '@/lib/jobs';
import { getInvoiceByJob, markInvoicePaidManually } from '@/lib/invoices';

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
    return NextResponse.json({ error: 'Invalid job id' }, { status: 400 });
  }

  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  if (job.status === 'cancelled') {
    return NextResponse.json({ error: 'Job is cancelled', code: 'cancelled' }, { status: 400 });
  }
  if (job.status === 'done') return NextResponse.json({ ok: true, alreadyDone: true });

  // Close = finalize + SETTLE, so an invoice must already exist. Closing a job
  // that was never invoiced would advance it straight to `done` with the entire
  // remaining balance untracked (no invoice row to reconcile), silently forfeiting
  // it. Refuse and point the operator at the complete→invoice step rather than
  // auto-creating here (surgical fix — keep this route settle-only).
  const invoice = await getInvoiceByJob(id);
  if (!invoice) {
    return NextResponse.json(
      {
        error: 'This job has no invoice yet — run "Complete" to create the invoice before closing.',
        code: 'no-invoice',
      },
      { status: 409 },
    );
  }
  // Settle the linked invoice if unpaid (close = finalize).
  if (invoice.status !== 'paid' && invoice.status !== 'cancelled') {
    try {
      await markInvoicePaidManually(invoice.id);
    } catch (err) {
      console.error('[api/jobs/:id/close] settle failed:', err);
      return NextResponse.json(
        { error: 'Could not settle the invoice', code: 'settle-failed' },
        { status: 409 },
      );
    }
  }

  // Advance the job to done through the legal steps.
  let current: JobRow = job;
  try {
    if (current.status === 'to_schedule' || current.status === 'scheduled') {
      current = (await setJobStatus(id, 'installed')) ?? current;
    }
    if (current.status === 'installed') {
      current = (await setJobStatus(id, 'requires_invoicing')) ?? current;
    }
    if (current.status === 'requires_invoicing') {
      await setJobStatus(id, 'done');
    }
  } catch (err) {
    // A concurrent close raced us to an already-advanced step. Re-read: if the
    // job landed at `done`, report success; otherwise surface the conflict.
    const fresh = await getJob(id);
    if (fresh && fresh.status === 'done') {
      return NextResponse.json({ ok: true, closed: true });
    }
    console.error('[api/jobs/:id/close] close race:', err);
    return NextResponse.json(
      { error: 'Could not close the job', code: 'close-conflict' },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true, closed: true });
}
