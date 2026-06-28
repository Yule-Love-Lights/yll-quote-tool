// src/app/api/inventory/purchase-order/route.ts
// Supplier purchase order (#82 Phase 3 auto-ordering, email channel).
//   GET  → preview the auto-generated PO (shortfall across booked jobs vs on-hand).
//   POST → email it to the supplier (Thunder) — HUMAN-GATED (staff trigger this).
//          The optional UNATTENDED weekly send lives in ./auto-send/route.ts.
// Service-role only.

import { NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { buildSupplierPurchaseOrder, emailSupplierPurchaseOrder } from '@/lib/inventory/purchaseOrder';

export const runtime = 'nodejs';

export async function GET() {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json(await buildSupplierPurchaseOrder());
  } catch (err) {
    console.error('[api/inventory/purchase-order] GET failed:', err);
    return NextResponse.json({ error: 'Failed to build purchase order' }, { status: 500 });
  }
}

export async function POST() {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const po = await buildSupplierPurchaseOrder();
  if (!po.lines.length) {
    return NextResponse.json({ error: 'Nothing to order — on-hand covers all booked jobs.' }, { status: 400 });
  }
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const res = await emailSupplierPurchaseOrder(po, date);
  if (!res.ok) return NextResponse.json({ error: res.error }, { status: res.status });
  return NextResponse.json({ ok: true, sent: po.lines.length });
}
