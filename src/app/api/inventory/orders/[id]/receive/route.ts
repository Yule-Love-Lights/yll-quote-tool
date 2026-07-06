// src/app/api/inventory/orders/[id]/receive/route.ts
// POST → mark a purchase order received and add its quantities to on-hand (P8,
// folds in #110 W7-002). Optional body { lines: [{sku, qty}] } lets staff edit
// the received quantities down (a short shipment) before confirming; omitted
// means a full receipt at the ordered quantities. Idempotent — receiveOrder
// atomically claims the row so a retry/double-click can't double-count stock.
// Service-role only.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { receiveOrder, listOrders } from '@/lib/inventory/orders';

export const runtime = 'nodejs';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  const { id } = await params;

  let body: unknown;
  try {
    body = req.headers.get('content-length') === '0' ? {} : await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const rawLines = (body as Record<string, unknown> | null)?.lines;
  const lines = Array.isArray(rawLines)
    ? (rawLines as { sku?: unknown; qty?: unknown }[])
        .filter((l) => typeof l?.sku === 'string')
        .map((l) => ({ sku: l.sku as string, qty: Number(l.qty) }))
    : undefined;

  const result = await receiveOrder(id, lines);
  if (result) return NextResponse.json(result);

  // receiveOrder returns null for both "order not found" (404) and "rejected an
  // unknown SKU in the override" (400) — distinguish by checking existence.
  const exists = (await listOrders()).some((o) => o.id === id);
  if (!exists) return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  return NextResponse.json({ error: 'Invalid receive lines — a SKU was not on the original order' }, { status: 400 });
}
