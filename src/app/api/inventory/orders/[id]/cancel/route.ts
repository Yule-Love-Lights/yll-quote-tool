// src/app/api/inventory/orders/[id]/cancel/route.ts
// POST → cancel an open purchase order, clearing it from the on-order delta
// math WITHOUT touching stock (P8, folds in #110 W7-002). Idempotent — a
// double-click loses the atomic claim and reports alreadyClosed rather than
// erroring. Service-role only.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { cancelOrder } from '@/lib/inventory/orders';
import { recordAutoSentSignature } from '@/lib/inventory/purchaseOrder';

export const runtime = 'nodejs';

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;
  const result = await cancelOrder(id);
  if (result === null) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  if (result === 'cancelled') {
    // Cancelling re-opens a shortfall that may reproduce a previously-sent
    // delta signature — reset the auto-send dedup so the cron re-orders the
    // cancelled quantity instead of suppressing it as "unchanged". Best-effort.
    try {
      await recordAutoSentSignature('');
    } catch (err) {
      console.error('[api/inventory/orders/cancel] signature reset failed:', err);
    }
  }
  return NextResponse.json({ ok: true, alreadyClosed: result === 'already-closed' ? true : undefined });
}
