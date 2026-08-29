import { getSupabaseServiceClient } from '@/lib/supabase';
import { logAdvertisingActivity } from '@/lib/advertising/activity';
import { YARD_SIGN_SKU } from '@/lib/advertising/signStock';

// Per-worker sign allotments (Naldo 2026-08-29): "I'll give a team member 50
// per week, and that's how we know how many they have... every time they
// take a photo, we take it out of the stock we give them." Issuances are an
// append-only ledger; a worker's REMAINING count is DERIVED — signs issued
// minus yard-sign photos taken (any status: a placed sign is a used sign,
// and a resubmission is the same sign, not a new one; door hangers never
// draw signs down). Nothing blocks a submission at zero — a photo of a
// standing sign must never be refused over bookkeeping; the balance is how
// the office KNOWS, not a gate.
//
// Issuing draws the WAREHOUSE pile down too (the signs physically leave the
// garage), floored at zero because that count is hand-set and can be stale.
// Both movements ride one audit row.

export type SignIssuance = {
  id: string;
  workerId: string;
  qty: number;
  issuedBy: string;
  note: string | null;
  createdAt: string;
};

export type WorkerSignBalance = {
  workerId: string;
  issuedTotal: number;
  signsUsed: number;
  remaining: number;
};

const SELECT = 'id, worker_id, qty, issued_by, note, created_at';
const PAGE = 1000;

type Row = {
  id: string;
  worker_id: string;
  qty: number;
  issued_by: string;
  note: string | null;
  created_at: string;
};

function toIssuance(row: Row): SignIssuance {
  return {
    id: row.id,
    workerId: row.worker_id,
    qty: row.qty,
    issuedBy: row.issued_by,
    note: row.note,
    createdAt: row.created_at,
  };
}

/** Hand a worker a stack of signs. Records the issuance, draws the warehouse
 * pile down (floored at zero), and audits both with prior and new. */
export async function issueSigns(
  workerId: string,
  qty: number,
  issuedBy: string,
  note?: string,
): Promise<{ issuance: SignIssuance; issuedQty: number }> {
  if (!Number.isInteger(qty) || qty <= 0) {
    throw new Error(`Invalid quantity: ${qty} — issue a whole number of signs, 1 or more`);
  }
  const db = getSupabaseServiceClient();
  if (!db) throw new Error('Supabase service role not configured');

  const { data, error } = await db
    .from('advertising_sign_issuances')
    .insert({
      worker_id: workerId.trim(),
      qty,
      issued_by: issuedBy,
      note: note?.trim() || null,
    })
    .select(SELECT)
    .maybeSingle();
  if (error) throw new Error(`issueSigns: ${error.message}`);
  if (!data) throw new Error('issueSigns: no row returned');
  const issuance = toIssuance(data as Row);

  // Draw the warehouse down: the signs left the garage. Best-effort CAS on
  // the current count (the count is manual; a lost race here just means the
  // other write's number stands and the audit records what THIS write saw).
  let warehousePrior: number | null = null;
  let warehouseNew: number | null = null;
  const { data: onHand } = await db
    .from('inventory_on_hand')
    .select('sku, on_hand_qty')
    .eq('sku', YARD_SIGN_SKU)
    .maybeSingle();
  if (onHand) {
    warehousePrior = (onHand as { on_hand_qty: number }).on_hand_qty;
    warehouseNew = Math.max(0, warehousePrior - qty);
    const { error: updateError } = await db
      .from('inventory_on_hand')
      .update({ on_hand_qty: warehouseNew })
      .eq('sku', YARD_SIGN_SKU)
      .eq('on_hand_qty', warehousePrior)
      .select('sku')
      .maybeSingle();
    if (updateError) console.error('issueSigns warehouse update:', updateError.message);
  }

  await logAdvertisingActivity({
    actor: issuedBy,
    action: 'signs_issued',
    workerId: issuance.workerId,
    detail: {
      qty,
      note: issuance.note,
      warehousePrior,
      warehouseNew,
    },
  });

  return { issuance, issuedQty: qty };
}

/** Every issuance for one worker, newest first (bounded display read). */
export async function listIssuances(workerId: string): Promise<SignIssuance[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];
  const { data, error } = await db
    .from('advertising_sign_issuances')
    .select(SELECT)
    .eq('worker_id', workerId.trim())
    .order('created_at', { ascending: false })
    .range(0, PAGE - 1);
  if (error) {
    console.error('listIssuances error:', error);
    return [];
  }
  return ((data ?? []) as Row[]).map(toIssuance);
}

async function issuedTotal(workerId: string): Promise<number> {
  const db = getSupabaseServiceClient();
  if (!db) return 0;
  // Sum via paged reads (money-adjacent count; never trust an unranged read).
  let total = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('advertising_sign_issuances')
      .select('id, worker_id, qty, issued_by, note, created_at')
      .eq('worker_id', workerId)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('issuedTotal error:', error);
      return total;
    }
    const rows = (data ?? []) as Row[];
    for (const r of rows) total += r.qty;
    if (rows.length < PAGE) break;
  }
  return total;
}

/** The worker's running sign balance: issued minus yard-sign photos taken
 * (any status), clamped at zero for display sanity when history predates
 * tracking. */
export async function getWorkerSignBalance(workerId: string): Promise<WorkerSignBalance> {
  const db = getSupabaseServiceClient();
  const id = workerId.trim();
  if (!db) return { workerId: id, issuedTotal: 0, signsUsed: 0, remaining: 0 };

  const issued = await issuedTotal(id);
  const { count, error } = await db
    .from('advertising_placements')
    .select('id', { count: 'exact', head: true })
    .eq('worker_id', id)
    .eq('kind', 'yard_sign');
  if (error) console.error('getWorkerSignBalance count error:', error);
  const signsUsed = count ?? 0;

  return {
    workerId: id,
    issuedTotal: issued,
    signsUsed,
    remaining: Math.max(0, issued - signsUsed),
  };
}
