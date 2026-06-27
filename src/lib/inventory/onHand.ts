// src/lib/inventory/onHand.ts
// Curated warehouse stock list (#82 Slice 1c). Service-role for writes; reads
// swallow to [] (mirrors catalog.ts). One row per stocked SKU.

import { getSupabaseServiceClient, getSupabaseClient } from '../supabase';

export type OnHandRow = {
  sku: string;
  on_hand_qty: number;
  reorder_point: number;
  storage_location: string | null;
};

const SELECT = 'sku, on_hand_qty, reorder_point, storage_location';

// Non-negative integer (counts + reorder points can't be negative/fractional).
export function toQty(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

export async function listOnHand(): Promise<OnHandRow[]> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('inventory_on_hand')
    .select(SELECT)
    .order('sku', { ascending: true });
  if (error) {
    console.error('listOnHand error:', error);
    return [];
  }
  return (data ?? []) as OnHandRow[];
}

// Upsert one row by sku. Only provided fields are written; a bare { sku } adds a
// row at the DB defaults (qty 0) without clobbering an existing one.
export async function upsertOnHand(row: {
  sku: string;
  on_hand_qty?: number;
  reorder_point?: number;
  storage_location?: string | null;
}): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  const payload: Record<string, unknown> = { sku: row.sku };
  if (row.on_hand_qty !== undefined) payload.on_hand_qty = toQty(row.on_hand_qty);
  if (row.reorder_point !== undefined) payload.reorder_point = toQty(row.reorder_point);
  if (row.storage_location !== undefined) {
    payload.storage_location =
      typeof row.storage_location === 'string' && row.storage_location.trim()
        ? row.storage_location.trim()
        : null;
  }
  const { error } = await sb.from('inventory_on_hand').upsert(payload, { onConflict: 'sku' });
  if (error) throw new Error(`upsertOnHand: ${error.message}`);
}

export async function deleteOnHand(sku: string): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  const { error } = await sb.from('inventory_on_hand').delete().eq('sku', sku);
  if (error) throw new Error(`deleteOnHand: ${error.message}`);
}
