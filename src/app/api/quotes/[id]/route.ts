// Per-quote endpoints.
//
//   GET    /api/quotes/[id]   — public, returns PortalQuote shape for the
//                                customer portal. UUID is the capability
//                                token (same model as /approve and /send).
//   DELETE /api/quotes/[id]   — admin-only, requires x-admin-secret.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { deleteQuote } from '@/lib/quotes';
import {
  loadPortalQuote,
  isValidQuoteId,
  PortalConfigError,
} from '@/lib/portal/loader';

export const runtime = 'nodejs';

function checkAdminSecret(req: NextRequest): NextResponse | null {
  const expected = process.env.ADMIN_SECRET;
  if (!expected) {
    return NextResponse.json({ error: 'ADMIN_SECRET not configured on server' }, { status: 503 });
  }
  const provided = req.headers.get('x-admin-secret');
  if (!provided || provided !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

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
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured (set SUPABASE_SERVICE_ROLE_KEY)' },
      { status: 503 },
    );
  }
  const authFail = checkAdminSecret(req);
  if (authFail) return authFail;
  const { id } = await params;
  try {
    await deleteQuote(id);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Delete failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
