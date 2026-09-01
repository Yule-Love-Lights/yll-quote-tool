import { getSupabaseServiceClient } from '@/lib/supabase';
import { logAdvertisingActivity } from '@/lib/advertising/activity';
import { YARD_SIGN_SKU } from '@/lib/advertising/signStock';
import { getAdvertisingWorker } from '@/lib/advertising/workers';

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

/** A second identical hand-out (same worker, same qty) inside this window
 * reads as a double-submitted form, not a second physical hand-out. */
const DUPLICATE_WINDOW_MS = 15_000;

/**
 * Hand a worker a stack of signs. Records the issuance, draws the warehouse
 * pile down (floored at zero, retried under a CAS so the audit never claims
 * a transition that lost its race — the setSignStockQty posture), and
 * audits everything with the acting admin. A TEST worker's issuance never
 * touches the real warehouse pile.
 */
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

  const worker = await getAdvertisingWorker(workerId);
  if (!worker) throw new Error(`issueSigns: no advertising worker found for id ${workerId.trim()}`);

  // Idempotency window: a retried/double-clicked identical hand-out returns
  // the row that already landed instead of doubling the ledger and drawing
  // the warehouse twice for one physical stack.
  const { data: latestRows } = await db
    .from('advertising_sign_issuances')
    .select(SELECT)
    .eq('worker_id', worker.id)
    .order('created_at', { ascending: false })
    .range(0, 0);
  const latest = ((latestRows ?? []) as Row[])[0];
  if (
    latest &&
    latest.qty === qty &&
    latest.issued_by === issuedBy && // a DIFFERENT admin's identical hand-out is a real second stack
    Date.now() - Date.parse(latest.created_at) < DUPLICATE_WINDOW_MS
  ) {
    return { issuance: toIssuance(latest), issuedQty: qty };
  }

  const { data, error } = await db
    .from('advertising_sign_issuances')
    .insert({
      worker_id: worker.id,
      qty,
      issued_by: issuedBy,
      note: note?.trim() || null,
    })
    .select(SELECT)
    .maybeSingle();
  if (error) throw new Error(`issueSigns: ${error.message}`);
  if (!data) throw new Error('issueSigns: no row returned');
  const issuance = toIssuance(data as Row);

  // Draw the warehouse down: the signs left the garage. CAS with retries so
  // the audit's numbers are TRUE (the admin lens on this PR caught the old
  // best-effort shape logging a transition that lost its race). A test
  // worker's signs are not real inventory and never touch the pile. If every
  // retry loses, the hand-out still stands and the audit says the warehouse
  // was NOT moved, with no claimed numbers.
  let warehousePrior: number | null = null;
  let warehouseNew: number | null = null;
  let warehouseUpdated = false;
  if (!worker.isTest) {
    for (let attempt = 0; attempt < 3 && !warehouseUpdated; attempt++) {
      const { data: onHand } = await db
        .from('inventory_on_hand')
        .select('sku, on_hand_qty')
        .eq('sku', YARD_SIGN_SKU)
        .maybeSingle();
      if (!onHand) break; // no stock row: nothing to draw down
      const prior = (onHand as { on_hand_qty: number }).on_hand_qty;
      const next = Math.max(0, prior - qty);
      const { data: updated, error: updateError } = await db
        .from('inventory_on_hand')
        .update({ on_hand_qty: next })
        .eq('sku', YARD_SIGN_SKU)
        .eq('on_hand_qty', prior)
        .select('sku')
        .maybeSingle();
      if (updateError) {
        console.error('issueSigns warehouse update:', updateError.message);
        break;
      }
      if (updated) {
        warehousePrior = prior;
        warehouseNew = next;
        warehouseUpdated = true;
      }
    }
  }

  const detail: Record<string, unknown> = {
    qty,
    note: issuance.note,
    warehouseUpdated,
  };
  if (worker.isTest) detail.testWorker = true;
  if (warehouseUpdated) {
    detail.warehousePrior = warehousePrior;
    detail.warehouseNew = warehouseNew;
  }

  await logAdvertisingActivity({
    actor: issuedBy,
    action: 'signs_issued',
    workerId: issuance.workerId,
    detail,
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
  // NO is_test filter here, deliberately, and this is the one counter in the
  // subsystem without one: every sibling counts ACROSS workers and must keep
  // test rows out of a real total, while this one is already scoped to a
  // single worker. A placement inherits its worker's is_test flag at capture,
  // so the rows can never be mixed — and filtering would zero a TEST worker's
  // own balance during a device check, which is exactly when the number is
  // being read. (Integration lens, S80 close: flagged as a consistency gap;
  // kept as-is with the reason written down instead.)
  const { count, error } = await db
    .from('advertising_placements')
    .select('id', { count: 'exact', head: true })
    .eq('worker_id', id)
    .eq('kind', 'yard_sign')
    .is('voided_at', null); // a voided placement gives the sign back
  if (error) console.error('getWorkerSignBalance count error:', error);
  const signsUsed = count ?? 0;

  return {
    workerId: id,
    issuedTotal: issued,
    signsUsed,
    remaining: Math.max(0, issued - signsUsed),
  };
}
