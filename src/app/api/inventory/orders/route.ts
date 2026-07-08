// src/app/api/inventory/orders/route.ts
// On-order ledger (P8, folds in #110 W7-002). GET lists sent purchase orders,
// optionally filtered to the open ones (?status=open) — what /inventory/orders
// shows below the shortfall preview. Service-role only — mirrors the other
// /api/inventory routes.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { listOrders } from '@/lib/inventory/orders';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const status = req.nextUrl.searchParams.get('status');
  try {
    const orders = await listOrders(status === 'open' ? { status: 'open' } : undefined);
    return NextResponse.json({ orders });
  } catch (err) {
    console.error('[api/inventory/orders] GET failed:', err);
    return NextResponse.json({ error: 'Failed to load orders' }, { status: 500 });
  }
}
