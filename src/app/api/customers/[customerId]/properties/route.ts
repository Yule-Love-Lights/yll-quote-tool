// Manual property add (#205) — the customer-profile Properties tab's "Add
// property" panel, for a property that's never had quote activity (so
// findOrCreateProperty/attachQuoteToCustomer never created a row for it).
// Mirrors tags/route.ts's shape (operator-only, one route, one concern).
//
// POST /api/customers/[customerId]/properties   (operator-only)
// Body: { address: string, nickname?: string }   — address required,
//   trimmed, non-empty; nickname optional.
// Response: { ok: true, property } | { error, code? }
//
// Delegates to createPropertyForCustomer (src/lib/customers.ts), which
// reuses findOrCreateProperty's normalizeAddress/address_key + UNIQUE-race-
// safe posture — a manual add that collides with an existing property (a
// formatting variant of an address quote activity already created)
// resolves to that row instead of creating a duplicate, and un-archives +
// labels it if that row was hidden. See that function's own comment for the
// full design.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { createPropertyForCustomer, getCustomer, type PropertyRow } from '@/lib/customers';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toJson(row: PropertyRow) {
  return {
    id: row.id,
    address: row.address,
    nickname: row.nickname ?? null,
    archivedAt: row.archived_at ?? null,
  };
}

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

  const { address, nickname } = (body as { address?: unknown; nickname?: unknown } | null) ?? {};
  if (typeof address !== 'string' || !address.trim()) {
    return NextResponse.json(
      { error: 'address is required', code: 'invalid-body' },
      { status: 400 },
    );
  }
  if (nickname !== undefined && typeof nickname !== 'string') {
    return NextResponse.json(
      { error: 'nickname must be a string if provided', code: 'invalid-body' },
      { status: 400 },
    );
  }

  // Confirmed to exist BEFORE the insert (properties.customer_id is a NOT
  // NULL FK to customers) so a bogus/deleted customer id 404s cleanly
  // instead of surfacing as an opaque foreign-key-violation 500.
  const customer = await getCustomer(customerId);
  if (!customer) {
    return NextResponse.json({ error: 'Customer not found' }, { status: 404 });
  }

  const { data, error } = await createPropertyForCustomer(customerId, { address, nickname });
  if (error || !data) {
    console.error('[api/customers/:customerId/properties] create failed:', error);
    return NextResponse.json({ error: 'Failed to add this property' }, { status: 500 });
  }

  return NextResponse.json({ ok: true, property: toJson(data) });
}
