// src/app/api/inventory/on-hand/route.ts
// On-hand stock API (#82 Slice 1c). GET lists; PUT adds/edits one row (upsert by
// sku); DELETE removes from the list. Service-role only — mirrors the other
// /api/inventory routes.

import { NextRequest, NextResponse } from 'next/server';
import { isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { listOnHand, upsertOnHand, deleteOnHand } from '@/lib/inventory/onHand';

export const runtime = 'nodejs';

export async function GET() {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  try {
    return NextResponse.json(await listOnHand());
  } catch (err) {
    console.error('[api/inventory/on-hand] GET failed:', err);
    return NextResponse.json({ error: 'Failed to load stock' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { sku, on_hand_qty, reorder_point, storage_location } = (body ?? {}) as Record<string, unknown>;
  if (typeof sku !== 'string' || !sku.trim()) {
    return NextResponse.json({ error: 'Body must include a `sku` string' }, { status: 400 });
  }
  try {
    await upsertOnHand({
      sku: sku.trim(),
      on_hand_qty: on_hand_qty as number | undefined,
      reorder_point: reorder_point as number | undefined,
      storage_location: storage_location as string | null | undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/inventory/on-hand] PUT failed:', err);
    return NextResponse.json({ error: 'Failed to save stock row' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ error: 'Supabase service role not configured' }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const sku = (body as Record<string, unknown>)?.sku;
  if (typeof sku !== 'string' || !sku.trim()) {
    return NextResponse.json({ error: 'Body must include a `sku` string' }, { status: 400 });
  }
  try {
    await deleteOnHand(sku.trim());
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[api/inventory/on-hand] DELETE failed:', err);
    return NextResponse.json({ error: 'Failed to remove stock row' }, { status: 500 });
  }
}
