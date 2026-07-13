// src/lib/inventory/orders.ts
// On-order ledger (P8, folds in #110 W7-002). Every SENT supplier purchase
// order gets a row here so future orders can subtract what's already en route
// (a true delta, not the full cumulative shortfall) and so staff can close an
// order out — received (adds its quantities to on-hand) or cancelled (drops it
// from the delta math without touching stock). Service-role for writes (throws
// when not configured — a silent write would drift the ledger from prod);
// reads swallow errors to [] (mirrors onHand.ts / catalog.ts — a dashboard
// widget shouldn't 500 just because a read blipped).

import { getSupabaseServiceClient } from '../supabase';
import { toQty, adjustOnHandAtomic } from './onHand';

export type OrderLine = { sku: string; name: string; qty: number };
export type ReceivedLine = { sku: string; qty: number };
export type InventoryOrder = {
  id: string;
  created_at: string;
  sent_at: string | null;
  channel: 'manual' | 'auto-cron' | 'auto-webhook';
  status: 'open' | 'received' | 'cancelled';
  received_at: string | null;
  lines: OrderLine[];
  received_lines: ReceivedLine[] | null;
  job_count: number;
};

const SELECT = 'id, created_at, sent_at, channel, status, received_at, lines, received_lines, job_count';

export async function listOrders(opts?: { status?: 'open' }): Promise<InventoryOrder[]> {
  const sb = getSupabaseServiceClient();
  if (!sb) return [];
  let q = sb.from('inventory_orders').select(SELECT).order('created_at', { ascending: false });
  if (opts?.status) q = q.eq('status', opts.status);
  const { data, error } = await q;
  if (error) {
    console.error('listOrders error:', error);
    return [];
  }
  return (data ?? []) as InventoryOrder[];
}

// Per-SKU sum of qty across every OPEN order — the delta term subtracted from
// need in computePurchaseOrder. Non-finite or negative stored qty counts as 0
// (a corrupt/edited-by-hand jsonb row shouldn't understate what to order).
export async function sumOpenOnOrder(): Promise<Map<string, number>> {
  const sums = new Map<string, number>();
  const open = await listOrders({ status: 'open' });
  for (const o of open) {
    for (const line of o.lines ?? []) {
      const qty = toQty(line.qty);
      sums.set(line.sku, (sums.get(line.sku) ?? 0) + qty);
    }
  }
  return sums;
}

// Insert a new open order (sent_at null until the send actually succeeds — see
// markOrderSent). Returns the new row id, or null when the insert fails; never
// throws — the caller (emailSupplierPurchaseOrder) decides how to surface it
// (specifically: don't send when this fails).
export async function recordOrder(input: {
  channel: InventoryOrder['channel'];
  lines: OrderLine[];
  jobCount: number;
}): Promise<string | null> {
  const sb = getSupabaseServiceClient();
  if (!sb) return null;
  const { data, error } = await sb
    .from('inventory_orders')
    .insert({ channel: input.channel, lines: input.lines, job_count: input.jobCount })
    .select('id')
    .single();
  if (error) {
    console.error('recordOrder error:', error);
    return null;
  }
  return (data as { id: string }).id;
}

// Best-effort — stamps sent_at once the email actually goes out. Never throws.
export async function markOrderSent(id: string): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) return;
  const { error } = await sb.from('inventory_orders').update({ sent_at: new Date().toISOString() }).eq('id', id);
  if (error) console.error('markOrderSent error:', error);
}

// Atomic conditional close — mirrors the read-before-claim pattern in
// prepareJobMaterials (jobs.ts): UPDATE ... WHERE id = $id AND status = 'open'.
// The winner (row flips open → cancelled) gets 'cancelled'; a loser (already
// closed by someone else) gets 'already-closed'; a missing row gets null.
export async function cancelOrder(id: string): Promise<'cancelled' | 'already-closed' | null> {
  const sb = getSupabaseServiceClient();
  if (!sb) return null;
  const { data, error } = await sb
    .from('inventory_orders')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('status', 'open')
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('cancelOrder error:', error);
    return null;
  }
  if (data) return 'cancelled';
  const { data: existing } = await sb.from('inventory_orders').select('id').eq('id', id).maybeSingle();
  return existing ? 'already-closed' : null;
}

export type ReceiveResult = { ok: true; alreadyDone?: true };

/**
 * Mark an order received and add its quantities to on-hand — the money-adjacent
 * (well, stock-adjacent) op. Mirrors prepareJobMaterials's read → atomic-claim →
 * write-per-line shape (jobs.ts, #110 W7-008): read first so a missing order or
 * a bad override returns before any claim is staked, then atomically flip
 * open → received (a double-click loses the claim and must never double-count
 * stock), then only the claim winner writes on-hand, one SKU at a time as an
 * ATOMIC delta (see adjustOnHandAtomic in onHand.ts) so a single failed write
 * can't unwind the claim or block the rest, and a concurrent receipt/decrement
 * on the same SKU can't clobber this one's increment.
 */
export async function receiveOrder(id: string, receivedLines?: ReceivedLine[]): Promise<ReceiveResult | null> {
  const sb = getSupabaseServiceClient();
  if (!sb) return null;

  const { data: row, error: readErr } = await sb
    .from('inventory_orders')
    .select(SELECT)
    .eq('id', id)
    .maybeSingle();
  if (readErr) {
    console.error('receiveOrder read error:', readErr);
    return null;
  }
  if (!row) return null;
  const order = row as InventoryOrder;
  if (order.status !== 'open') return { ok: true, alreadyDone: true };

  // Resolve the effective received lines. An override may only touch SKUs that
  // were actually on the order — staff can't receive something never ordered —
  // must not repeat a SKU (the receive loop below writes on-hand once per
  // entry, so a dupe would double-count stock), and must cover EVERY ordered
  // SKU (a subset would close the order while the missing lines' stock
  // silently vanished from both on-hand and on-order; a genuinely-unshipped
  // line is received as qty 0, explicit and auditable).
  const orderedSkus = new Set(order.lines.map((l) => l.sku));
  let effective: ReceivedLine[];
  if (receivedLines) {
    for (const l of receivedLines) {
      if (!orderedSkus.has(l.sku)) {
        console.error(`receiveOrder: rejected unknown SKU "${l.sku}" not on order ${id}`);
        return null;
      }
    }
    const overrideSkus = new Set(receivedLines.map((l) => l.sku));
    if (overrideSkus.size !== receivedLines.length) {
      console.error(`receiveOrder: rejected a duplicated SKU in the override for order ${id}`);
      return null;
    }
    for (const sku of orderedSkus) {
      if (!overrideSkus.has(sku)) {
        console.error(`receiveOrder: rejected incomplete override — SKU "${sku}" on order ${id} is missing`);
        return null;
      }
    }
    effective = receivedLines.map((l) => ({ sku: l.sku, qty: toQty(l.qty) }));
  } else {
    effective = order.lines.map((l) => ({ sku: l.sku, qty: toQty(l.qty) }));
  }

  // Atomic claim — only the caller that flips open → received proceeds to
  // increment stock.
  const { data: claimed, error: claimErr } = await sb
    .from('inventory_orders')
    .update({ status: 'received', received_at: new Date().toISOString(), received_lines: effective })
    .eq('id', id)
    .eq('status', 'open')
    .select('id')
    .maybeSingle();
  if (claimErr) {
    console.error('receiveOrder claim error:', claimErr);
    return null;
  }
  if (!claimed) return { ok: true, alreadyDone: true };

  for (const line of effective) {
    try {
      await adjustOnHandAtomic(sb, line.sku, line.qty);
    } catch (err) {
      // A single failed write shouldn't unwind the claim; staff can reconcile
      // that SKU manually on the Stock tab. Log for visibility.
      console.error(`receiveOrder: on-hand write failed for ${line.sku}:`, err);
    }
  }
  return { ok: true };
}
