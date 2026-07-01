// GET /api/pipeline/[quoteId] — live pipeline record (#83 ops).
//
// Returns the current pipeline state for a quote: its derived status + the
// linked job and invoice. Consumed by <PipelineActionsMenu> on open (lazy
// read — not baked into every list payload). No writes.
//
// Auth: requireOperator() gate (dormant — always passes while dev). No
// Supabase service role needed; reads use the same loader as the edit page.

import { NextRequest, NextResponse } from 'next/server';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { isSupabaseConfigured } from '@/lib/supabase';
import { getQuoteRaw } from '@/lib/quotes';
import { deriveStatus } from '@/lib/quoteStatus';
import { getJobByQuote } from '@/lib/jobs';
import { getInvoiceByJob } from '@/lib/invoices';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ quoteId: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 503 });
  }

  const { quoteId } = await params;
  if (!UUID_RE.test(quoteId)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  const quote = await getQuoteRaw(quoteId);
  if (!quote) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  const job = await getJobByQuote(quoteId);
  const invoice = job ? await getInvoiceByJob(job.id) : null;

  return NextResponse.json({
    quoteId,
    quoteStatus: deriveStatus(quote),
    isTest: !!quote.is_test,
    depositPaid: !!quote.deposit_paid_at,
    job: job ? { id: job.id, status: job.status } : null,
    invoice: invoice ? { id: invoice.id, status: invoice.status, balance: invoice.balance } : null,
  });
}
