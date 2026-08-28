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

// How many times an on-hand adjust re-reads and retries when a concurrent writer
// bumps the row out from under us before we win (mirrors designs.ts).
const MAX_ONHAND_RETRIES = 5;

// The actual before/after/applied on a SKU from one adjustOnHandAtomic call.
// `applied` is the SIGNED delta that actually landed — it can differ in
// MAGNITUDE from the requested `delta` when the floor-at-0 clamp bites (e.g. a
// job asks to deduct 5 but only 3 remain on-hand, so applied is -3, not -5).
// Row 329 fix (jobs.ts prepareJobMaterials): callers that persist a durable
// snapshot of what was taken off stock must record `applied`, never the
// requested `delta` — reversing a snapshot built from the requested amount can
// over-credit on-hand back above where it started.
export type OnHandAdjustResult = { before: number; after: number; applied: number };

/**
 * Add `delta` (a SIGNED integer — positive for a receipt, negative for a job
 * decrement) to a SKU's on-hand qty ATOMICALLY, guarded by an updated_at
 * optimistic-concurrency check (modeled on designs.updateExtraPhotosAtomic). The
 * result never goes below 0 — so the ACTUAL applied delta can be smaller in
 * magnitude than the requested one; the returned `applied` is that ground truth.
 *
 * Why not read-then-absolute-set (upsertOnHand): two writers touching the same
 * SKU — a receipt increment and a job decrement, or two job decrements — each
 * snapshot the same on-hand qty, then each writes its own absolute "after". Last
 * write wins and silently drops the other's delta: phantom stock, which makes the
 * next supplier PO under- or over-order. Reading on_hand_qty + updated_at and
 * writing under a `.eq('updated_at', snapshot)` precondition turns each side into
 * a true delta: the inventory_on_hand before-update trigger bumps updated_at on
 * every write, so a racing commit invalidates our precondition (0 rows matched)
 * and we retry against the fresh value.
 *
 * Talks to inventory_on_hand directly (not upsertOnHand, which does an absolute
 * set) because the atomic-delta guard is the whole point.
 */
export async function adjustOnHandAtomic(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  sku: string,
  delta: number,
): Promise<OnHandAdjustResult> {
  const d = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  if (d === 0) return { before: 0, after: 0, applied: 0 };
  for (let attempt = 0; attempt < MAX_ONHAND_RETRIES; attempt++) {
    const { data, error } = await sb
      .from('inventory_on_hand')
      .select('on_hand_qty, updated_at')
      .eq('sku', sku)
      .maybeSingle();
    if (error) throw new Error(`on-hand read: ${error.message}`);

    if (!data) {
      // No row for this SKU yet — create it at max(0, delta). A negative delta
      // with no row means nothing to deduct, so it floors to 0. ignoreDuplicates
      // so a concurrent insert of the same SKU doesn't error; if we lose that
      // race the upsert returns no row and we loop to read + adjust theirs.
      const seed = Math.max(0, d);
      const { data: inserted, error: insErr } = await sb
        .from('inventory_on_hand')
        .upsert({ sku, on_hand_qty: seed }, { onConflict: 'sku', ignoreDuplicates: true })
        .select('sku');
      if (insErr) throw new Error(`on-hand insert: ${insErr.message}`);
      if (Array.isArray(inserted) && inserted.length > 0) return { before: 0, after: seed, applied: seed };
      continue;
    }

    const row = data as { on_hand_qty: number; updated_at: string };
    const before = toQty(row.on_hand_qty);
    const next = Math.max(0, before + d);
    const { data: updated, error: updErr } = await sb
      .from('inventory_on_hand')
      .update({ on_hand_qty: next })
      .eq('sku', sku)
      .eq('updated_at', row.updated_at)
      .select('sku');
    if (updErr) throw new Error(`on-hand write: ${updErr.message}`);
    // A non-empty result means our updated_at precondition matched — we won.
    // An empty result means another writer bumped the row first; retry.
    if (Array.isArray(updated) && updated.length > 0) return { before, after: next, applied: next - before };
  }
  throw new Error(`on-hand write: too many concurrent-update retries for ${sku}`);
}
