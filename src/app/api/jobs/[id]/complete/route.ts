// Mark a job installed/complete → auto-create its invoice (ledger #83, SPEC §4.3).
//
// POST /api/jobs/[id]/complete   (operator-only)
// Body: none — the job id is in the URL.
// Response: { ok, settled, invoice: {...} } | { error, code? }
//
// "Complete" advances the job along the BILLING axis to `requires_invoicing`
// (to_schedule/scheduled → installed → requires_invoicing) and creates the
// invoice (full total, the actual paid deposit applied → balance). The invoice
// creator is idempotent on job_id, so repeated clicks / retries don't double it.
//
// This route does NOT collect the balance — that's the separate "Charge remaining
// balance" step (the chargeBalanceOnFile seam, gated on the confirmed Valor
// card-on-file capability + #81). The ONE exception handled here: when the deposit
// already covers the full total (balance ≤ 0 — e.g. an amended-down order), there
// is nothing to collect, so the invoice is settled `paid` and the job closed.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { getJob, setJobStatus, type JobRow } from '@/lib/jobs';
import { createInvoiceFromJob, setInvoiceStatus } from '@/lib/invoices';
import { moveQuoteCardToInstalled } from '@/lib/integrations/ghlQuoteCard';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Advance a job to `requires_invoicing` via the LEGAL jobStatus transitions
// (to_schedule/scheduled → installed → requires_invoicing). Idempotent: a job
// already at requires_invoicing or done is left untouched by the caller. Returns
// the current row, or null if a step failed.
async function advanceToRequiresInvoicing(job: JobRow): Promise<JobRow | null> {
  let current: JobRow = job;
  if (current.status === 'to_schedule' || current.status === 'scheduled') {
    const installed = await setJobStatus(current.id, 'installed');
    if (!installed) return null;
    current = installed;
    // Best-effort GHL card move on the FIRST installed transition (#GHL
    // pipeline sync) — shared with /api/jobs/[id]/close; never throws.
    await moveQuoteCardToInstalled(current.quote_id);
  }
  if (current.status === 'installed') {
    const ri = await setJobStatus(current.id, 'requires_invoicing');
    if (!ri) return null;
    current = ri;
  }
  return current;
}

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
    return NextResponse.json({ error: 'Job is cancelled', code: 'cancelled' }, { status: 400 });
  }

  // Advance to requires_invoicing (skip when already there or past at `done`).
  if (job.status !== 'requires_invoicing' && job.status !== 'done') {
    try {
      const advanced = await advanceToRequiresInvoicing(job);
      if (!advanced) {
        return NextResponse.json({ error: 'Could not advance the job status' }, { status: 500 });
      }
    } catch (err) {
      // A concurrent complete likely advanced the job past a step → setJobStatus
      // threw on the now-illegal transition (review MEDIUM). Re-read: if it's
      // already invoiceable, proceed (createInvoiceFromJob is idempotent); else
      // surface a conflict instead of an unhandled 500.
      const fresh = await getJob(id);
      if (!fresh || (fresh.status !== 'requires_invoicing' && fresh.status !== 'done')) {
        console.error('[api/jobs/:id/complete] advance failed:', err);
        return NextResponse.json(
          { error: 'Could not advance the job status', code: 'advance-conflict' },
          { status: 409 },
        );
      }
    }
  }

  // Auto-create the invoice (idempotent on job_id). Null = the job has no quote
  // to price from.
  const invoice = await createInvoiceFromJob(id);
  if (!invoice) {
    return NextResponse.json(
      { error: 'Could not create the invoice (job has no linked quote)', code: 'no-quote' },
      { status: 409 },
    );
  }

  // Deposit already covers the full total (balance ≤ 0): nothing to collect —
  // settle the invoice `paid` and close the job. (An overpayment surfaces as the
  // invoice's credit_note for a MANUAL Valor refund — no refund integration.) A
  // positive balance is collected by the separate "Charge remaining balance" step.
  let settled = false;
  if (invoice.balance <= 0 && invoice.status === 'draft') {
    try {
      await setInvoiceStatus(invoice.id, 'paid');
      const fresh = await getJob(id);
      if (fresh && fresh.status === 'requires_invoicing') await setJobStatus(id, 'done');
      settled = true;
    } catch (err) {
      // A concurrent complete / re-entry raced the illegal-transition guards (the
      // in-memory `draft` check is stale). The other request is settling it — don't
      // 500; report unsettled and let a refresh reflect the final state (review LOW).
      console.error('[api/jobs/:id/complete] settle race:', err);
    }
  }

  return NextResponse.json({
    ok: true,
    settled,
    invoice: {
      id: invoice.id,
      invoice_number: invoice.invoice_number,
      total: invoice.total,
      deposit_applied: invoice.deposit_applied,
      balance: invoice.balance,
      credit_note: invoice.credit_note,
      status: settled ? 'paid' : invoice.status,
    },
  });
}
