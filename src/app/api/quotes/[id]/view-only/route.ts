// Staff-only "Mark as view-only" toggle (#176).
//
// POST /api/quotes/[id]/view-only   (operator-only)
// Body: { viewOnly: boolean }   — strict: must be a real boolean.
// Response: { ok: true, viewOnly: boolean } | { error, code? }
//
// A view-only quote is one staff spun up purely so a customer can browse a
// designed scene (colour picker, prices) without being able to approve or pay
// a real deposit. This route lets staff set/unset the flag from the admin
// quote detail page. The flag is read by:
//   - the portal (src/lib/portal/adapter.ts) — StickyBottomBar shows a
//     neutral browsing strip instead of approve/pay/decline
//   - the approve/pay/decline/request-changes routes — each 409s when set

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';

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
    return NextResponse.json({ error: 'Invalid quote id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const viewOnly = (body as { viewOnly?: unknown } | null)?.viewOnly;
  if (typeof viewOnly !== 'boolean') {
    return NextResponse.json(
      { error: 'viewOnly must be a boolean', code: 'invalid-body' },
      { status: 400 },
    );
  }

  const sb = getSupabaseServiceClient()!;
  const { data, error } = await sb
    .from('quotes')
    .update({ view_only: viewOnly })
    .eq('id', id)
    .select('id, view_only')
    .maybeSingle<{ id: string; view_only: boolean }>();

  if (error) {
    console.error('[api/quotes/:id/view-only] update failed:', error);
    return NextResponse.json({ error: 'Failed to update the quote' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, viewOnly: data.view_only });
}
