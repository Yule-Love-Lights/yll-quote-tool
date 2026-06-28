// Per-quote endpoints.
//
//   GET    /api/quotes/[id]   — public, returns PortalQuote shape for the
//                                customer portal. UUID is the capability
//                                token (same model as /approve and /send).
//   DELETE /api/quotes/[id]   — operator-only (session perimeter, ledger #81).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { deleteQuote } from '@/lib/quotes';
import {
  loadPortalQuote,
  isValidQuoteId,
  PortalConfigError,
} from '@/lib/portal/loader';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

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
  try {
    await deleteQuote(id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
