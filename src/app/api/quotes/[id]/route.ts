// Per-quote endpoints.
//
//   GET    /api/quotes/[id]   — public, returns PortalQuote shape for the
//                                customer portal. UUID is the capability
//                                token (same model as /approve and /send).
//   DELETE /api/quotes/[id]   — operator-only (session perimeter, ledger #81).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { deleteQuote } from '@/lib/quotes';
import {
  loadPortalQuote,
  isValidQuoteId,
  PortalConfigError,
} from '@/lib/portal/loader';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

// W1-016: a per-row delete of a BOOKED (deposit-paid) or customer-approved quote
// cascades away its job, invoice, approval snapshot (signature + amendment trail),
// and Valor txn linkage (the FK CASCADE on jobs.quote_id / invoices.quote_id). One
// mis-click on the admin list can irreversibly erase booked revenue whose only
// remaining record lives in the Valor dashboard. Mirror the bulk-wipe's confirm-
// token second factor (src/app/api/quotes/route.ts g29): require this exact header
// to delete a real (non-test) money-bearing quote. Draft / test rows keep the
// frictionless one-click delete.
const DELETE_BOOKED_CONFIRM = 'DELETE BOOKED QUOTE';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isValidQuoteId(id)) {
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  try {
    const portal = await loadPortalQuote(id);
    if (!portal) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
    }
    return NextResponse.json({ quote: portal });
  } catch (err) {
    if (err instanceof PortalConfigError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    const msg = err instanceof Error ? err.message : 'Lookup failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }
  const { id } = await params;

  // W1-016: load the money-bearing flags first and require the confirm-token
  // second factor before erasing a real booked/approved quote (and its cascaded
  // job + invoice + snapshot). Narrow select — no need for the heavy inputs/result
  // jsonb here. A missing row falls through to deleteQuote (a no-op delete).
  const sb = getSupabaseServiceClient()!;
  const { data: row } = await sb
    .from('quotes')
    .select('deposit_paid_at, customer_approved_at, is_test')
    .eq('id', id)
    .maybeSingle<{ deposit_paid_at: string | null; customer_approved_at: string | null; is_test: boolean }>();
  const isProtected = !!row && !row.is_test && (!!row.deposit_paid_at || !!row.customer_approved_at);
  if (isProtected && req.headers.get('x-confirm-delete-booked') !== DELETE_BOOKED_CONFIRM) {
    return NextResponse.json(
      {
        error:
          `This quote is ${row!.deposit_paid_at ? 'booked (deposit paid)' : 'customer-approved'} — deleting it also erases its job, invoice, payment record, and every internal staff note on it. To confirm, send header x-confirm-delete-booked: ${DELETE_BOOKED_CONFIRM}`,
        code: 'confirm-required',
      },
      { status: 428 }, // Precondition Required
    );
  }

  try {
    await deleteQuote(id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
