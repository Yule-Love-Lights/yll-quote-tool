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
import { deriveStatus, isTerminalBrowseStatus } from '@/lib/quoteStatus';
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
  const quoteStatus = deriveStatus(quote);

  // Row 340: a revive (declined/abandoned → sent, see /send's canRevive)
  // reseeds the customer's portal from whatever browsing_selection they last
  // saved BEFORE declining/abandoning, with no staff visibility into that —
  // surface a summary here so PipelineActionsMenu can tell the operator
  // BEFORE they click Send. Positive-match gate (isTerminalBrowseStatus,
  // the same declined/abandoned set canRevive/canTransition use) — a
  // leftover browsing_selection on any OTHER status (a live sent/viewed
  // quote's real in-progress selection) is not this feature's concern and
  // must never surface here as if it were stale.
  //
  // Row 324 fix round (admin lens MED): staffSet threaded through so the
  // operator confirm can distinguish a selection STAFF preselected from one
  // the customer actually chose — without this, a declined/abandoned quote
  // that staff (not the customer) preselected shows the confirm's "this
  // customer has a saved selection" wording, presenting a colleague's pick
  // as the customer's own choice. Deliberately still surfaces either way
  // (see PipelineActionsMenu): the portal really will reseed from it either
  // way, so suppressing the warning for a staff-set selection would trade a
  // wrong label for a missing warning.
  const rawSelection = quote.browsing_selection;
  const staleBrowsingSelection =
    isTerminalBrowseStatus(quoteStatus) && rawSelection
      ? {
          packageId: typeof rawSelection.packageId === 'string' ? rawSelection.packageId : null,
          itemCount: Array.isArray(rawSelection.selectedItemIds) ? rawSelection.selectedItemIds.length : 0,
          savedAt: quote.browsing_selection_updated_at ?? null,
          staffSet: !!(rawSelection.staffSet && typeof rawSelection.staffSet === 'object'),
        }
      : null;

  return NextResponse.json({
    quoteId,
    quoteStatus,
    isTest: !!quote.is_test,
    depositPaid: !!quote.deposit_paid_at,
    // View-only portal (#176): threaded through so pipelineActions() can
    // suppress the customer-state-changing offers on a browse-only quote.
    viewOnly: !!quote.view_only,
    job: job ? { id: job.id, status: job.status } : null,
    invoice: invoice ? { id: invoice.id, status: invoice.status, balance: invoice.balance } : null,
    staleBrowsingSelection,
  });
}
