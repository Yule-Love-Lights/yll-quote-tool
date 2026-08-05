// Staff-editable NCE + YLL Neighbor customer tags (#198), mirroring
// tenure-years/route.ts's shape (operator-only, one route, one concern).
//
// POST /api/customers/[customerId]/tags   (operator-only)
// Body: { isNce?: boolean, isYllNeighbor?: boolean }   — at least one
//   required; each, when present, must be a real boolean. Partial update:
//   only the provided key(s) are written, so one chip can toggle without
//   touching the other.
// Response: { ok: true, isNce: boolean, isYllNeighbor: boolean } | { error, code? }
//
// Unlike quote-tag propagation (forward-only — only ever sets true), THIS
// route is the staff add/remove UI on the customer profile: either tag can be
// explicitly turned OFF here. It never touches any quote — untagging a
// customer never untags their quotes (ledger #198, forward-only is one-
// directional: quote→customer propagation only ever writes true; this route
// is the one legitimate way a customer tag goes back to false).

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured, getSupabaseServiceClient } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  const denied = await requireOperator();
  if (denied) return denied;

  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }

  const { customerId } = await params;
  if (!UUID_RE.test(customerId)) {
    return NextResponse.json({ error: 'Invalid customer id' }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { isNce, isYllNeighbor } = (body as { isNce?: unknown; isYllNeighbor?: unknown } | null) ?? {};
  if (isNce !== undefined && typeof isNce !== 'boolean') {
    return NextResponse.json(
      { error: 'isNce must be a boolean if provided', code: 'invalid-body' },
      { status: 400 },
    );
  }
  if (isYllNeighbor !== undefined && typeof isYllNeighbor !== 'boolean') {
    return NextResponse.json(
      { error: 'isYllNeighbor must be a boolean if provided', code: 'invalid-body' },
      { status: 400 },
    );
  }
  if (isNce === undefined && isYllNeighbor === undefined) {
    return NextResponse.json(
      { error: 'At least one of isNce/isYllNeighbor must be provided', code: 'invalid-body' },
      { status: 400 },
    );
  }

  const patch: Record<string, boolean> = {};
  if (isNce !== undefined) patch.is_nce = isNce;
  if (isYllNeighbor !== undefined) patch.is_yll_neighbor = isYllNeighbor;

  const sb = getSupabaseServiceClient()!;
  const { data, error } = await sb
    .from('customers')
    .update(patch)
    .eq('id', customerId)
    .select('id, is_nce, is_yll_neighbor')
    .maybeSingle<{ id: string; is_nce: boolean; is_yll_neighbor: boolean }>();

  if (error) {
    console.error('[api/customers/:customerId/tags] update failed:', error);
    return NextResponse.json({ error: 'Failed to update this customer' }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, isNce: data.is_nce, isYllNeighbor: data.is_yll_neighbor });
}
