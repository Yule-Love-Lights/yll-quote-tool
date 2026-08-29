import { getSupabaseServiceClient } from '@/lib/supabase';
import { upsertOnHand } from '@/lib/inventory/onHand';
import { logAdvertisingActivity } from '@/lib/advertising/activity';

// Phase-2 sign stock (Naldo's ruling: catalog SKU plus MANUAL reconciliation
// first; per-unit tracking only after placements prove the workflow). The
// YLL-YARD-SIGN SKU lives in the shared inventory_catalog/inventory_on_hand
// tables (seeded by migrations/2026-08-29-yard-sign-sku.sql), so it also
// shows up on the existing /inventory/stock page. NOTHING auto-decrements
// it: accepting a placement never touches stock. The office counts the real
// pile, types the number, and reads it beside the accepted-sign counts.

export const YARD_SIGN_SKU = 'YLL-YARD-SIGN';

export type SignStock = {
  onHandQty: number;
  reorderPoint: number;
  /** Non-test yard signs ACCEPTED all time — signs standing in the world. */
  acceptedAllTime: number;
  /** Non-test yard signs still pending or resubmitted — likely also out. */
  pendingReview: number;
};

async function countYardSigns(
  db: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  statuses: string[],
): Promise<number> {
  let query = db
    .from('advertising_placements')
    .select('id', { count: 'exact', head: true })
    .eq('kind', 'yard_sign')
    .eq('is_test', false);
  query = statuses.length === 1 ? query.eq('status', statuses[0]) : query.in('status', statuses);
  const { count, error } = await query;
  if (error) {
    console.error('countYardSigns error:', error);
    return 0;
  }
  return count ?? 0;
}

export async function getSignStock(): Promise<SignStock> {
  const db = getSupabaseServiceClient();
  if (!db) return { onHandQty: 0, reorderPoint: 0, acceptedAllTime: 0, pendingReview: 0 };

  const { data, error } = await db
    .from('inventory_on_hand')
    .select('sku, on_hand_qty, reorder_point, storage_location')
    .eq('sku', YARD_SIGN_SKU)
    .maybeSingle();
  if (error) console.error('getSignStock on-hand error:', error);
  const row = (data ?? null) as { on_hand_qty: number; reorder_point: number } | null;

  const [acceptedAllTime, pendingReview] = await Promise.all([
    countYardSigns(db, ['accepted']),
    countYardSigns(db, ['pending', 'resubmitted']),
  ]);

  return {
    onHandQty: row?.on_hand_qty ?? 0,
    reorderPoint: row?.reorder_point ?? 0,
    acceptedAllTime,
    pendingReview,
  };
}

/**
 * Manual reconciliation write: the admin counted the pile and this is the
 * number. Audits prior and new (an adjustment with no before-value cannot
 * answer "where did 30 signs go" later); a failed write logs nothing.
 */
export async function setSignStockQty(qty: number, actor: string): Promise<SignStock> {
  if (!Number.isInteger(qty) || qty < 0) {
    throw new Error(`Invalid count: ${qty} — the sign count must be a whole number, 0 or more`);
  }
  const prior = await getSignStock();
  await upsertOnHand({ sku: YARD_SIGN_SKU, on_hand_qty: qty });
  await logAdvertisingActivity({
    actor,
    action: 'sign_stock_adjusted',
    detail: { sku: YARD_SIGN_SKU, priorQty: prior.onHandQty, newQty: qty },
  });
  return { ...prior, onHandQty: qty };
}
