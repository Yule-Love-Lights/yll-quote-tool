// src/lib/inventory/purchaseOrder.ts
// Auto purchase-order generator (#82 Phase 3 — "AI auto-ordering", email channel).
// DEMAND-DRIVEN + deterministic: aggregate the material needs of the active,
// not-yet-prepped jobs, subtract on-hand AND what's already open on order (the
// P8 on-order ledger — #110 W7-002), and the positive remainder is what to order
// from the supplier. No arbitrary reorder target, no LLM — the design→SKU
// projection is the intelligence. The actual SEND is human-gated (staff click) —
// The manual send is human-gated (staff click). An OPTIONAL unattended cron
// auto-send exists too (off by default behind PO_AUTO_SEND_ENABLED), with a
// signature dedup so it never re-sends an unchanged order.

import { getSupabaseServiceClient } from '../supabase';
import type { Scene } from '@/lib/design/sceneTypes';
import { getInventoryBindings } from './bindings';
import { listCatalog } from './catalog';
import { listOnHand } from './onHand';
import { recordOrder, markOrderSent, cancelOrder, sumOpenOnOrder, type InventoryOrder } from './orders';
import { projectMaterials, aggregateMaterials } from './materialsProjection';
import { colorChoiceFromSnapshot } from './resolveInstalls';
import { isActiveFulfillment } from './jobs';
import { permanentBomFromQuote, includedPermanentSidesFromSnapshot } from '@/lib/permanent/bomFromQuote';
import type { PermanentQuoteFields, PermanentSide } from '@/lib/permanent/types';
import { bistroBomFromQuote } from '@/lib/permanentBistro/bomFromQuote';
import type { BistroBomLine } from '@/lib/permanentBistro/bom';
import type { PermanentBistroInputFields } from '@/lib/permanentBistro/types';
import { BISTRO_CATALOG } from './bistroCatalog';
import { isHighLevelConfigured, sendEmail } from '@/lib/integrations/highlevel';
import { supplierOrderEmailSubject, supplierOrderEmailHtml } from '@/lib/integrations/quoteMessages';
import { appBaseUrl } from '@/lib/integrations/telegramNotify';
import { notifyTelegramAudience } from '@/lib/integrations/telegramRouting';
import { poSentMessage } from '@/lib/integrations/telegramMessages';

export type POInput = { sku: string; needed: number; onHand: number; onOrder: number };
export type POLine = { sku: string; needed: number; onHand: number; onOrder: number; order: number };

// Pure: per SKU, order = ceil(need) − on-hand − on-order (floored at 0 at each
// step, and the final result never negative). Drops anything already covered by
// stock + what's already en route; sorted by SKU for a stable order sheet.
export function computePurchaseOrder(items: POInput[]): POLine[] {
  return items
    .map((i) => {
      const needed = Math.max(0, Math.ceil(i.needed));
      const onHand = Math.max(0, i.onHand);
      const onOrder = Math.max(0, i.onOrder);
      return { sku: i.sku, needed, onHand, onOrder, order: Math.max(0, needed - onHand - onOrder) };
    })
    .filter((l) => l.order > 0)
    .sort((a, b) => a.sku.localeCompare(b.sku));
}

export type PurchaseOrderLine = POLine & { name: string };
export type SupplierPurchaseOrder = { lines: PurchaseOrderLine[]; jobCount: number };

// Pure (#117, Naldo 2026-07-11): which of a bistro BOM's lines belong on the
// pooled THUNDER auto-PO. Thunder-supplier lines only — the Home Depot posts/
// concrete and the Amazon timer are manual buys on the per-quote order sheet
// (bistro-bom/print), and the as-needed zip-wire row has no computable qty.
export function poolableBistroPoLines(
  lines: readonly Pick<BistroBomLine, 'sku' | 'qty' | 'supplier' | 'asNeeded'>[],
): { sku: string; qty: number }[] {
  return lines
    .filter((l) => l.supplier === 'thunder' && !l.asNeeded && l.qty > 0)
    .map((l) => ({ sku: l.sku, qty: l.qty }));
}

/**
 * Build the supplier purchase order from current demand: every active job that
 * hasn't been prepped yet (its stock isn't deducted), aggregated and compared to
 * on-hand MINUS what's already open on order (the P8 ledger — #110 W7-002: a
 * delta, not the full cumulative shortfall, so a re-send only lists the NEW
 * need). Only bound SKUs are orderable (unbound concepts have no SKU). Returns
 * empty lines when nothing is short. Untracked SKUs count as 0 on-hand (order the
 * full need — we have no stock record for them).
 */
export async function buildSupplierPurchaseOrder(): Promise<SupplierPurchaseOrder> {
  const db = getSupabaseServiceClient();
  if (!db) return { lines: [], jobCount: 0 };

  // Active (pre-install) jobs whose materials haven't been pulled yet.
  const { data: jobRows } = await db
    .from('jobs')
    .select('quote_id, status, stock_decremented_at')
    .is('stock_decremented_at', null);
  let active = (jobRows ?? []).filter(
    (j) => isActiveFulfillment((j as { status: string }).status) && (j as { quote_id: string | null }).quote_id,
  ) as { quote_id: string }[];
  if (!active.length) return { lines: [], jobCount: 0 };

  // Test Quote safety (ledger #93): a test job IS a real jobs row, but its
  // materials must NEVER reach the real supplier PO. is_test lives on the quote —
  // drop any active job whose quote is a test quote before aggregating demand.
  // P8 PR-2: also select service_type + inputs so a permanent job's demand can
  // be accumulated from the BOM engine instead of the scene projection below.
  const allQuoteIds = [...new Set(active.map((j) => j.quote_id))];
  const { data: quoteRows } = await db
    .from('quotes')
    .select('id, is_test, approval_snapshot, service_type, inputs')
    .in('id', allQuoteIds);
  const testQuoteIds = new Set(
    (quoteRows ?? []).filter((r) => (r as { is_test: boolean | null }).is_test).map((r) => (r as { id: string }).id),
  );
  // #92 — each active quote's approved color choice, for the pattern-aware projection.
  const colorChoiceByQuote = new Map(
    (quoteRows ?? []).map((r) => [
      (r as { id: string }).id,
      colorChoiceFromSnapshot((r as { approval_snapshot: unknown }).approval_snapshot),
    ]),
  );
  // P8 PR-2: which active quotes are permanent (positive gate), and their stored
  // permanent inputs to feed permanentBomFromQuote.
  const permanentFieldsByQuote = new Map<string, PermanentQuoteFields | undefined>(
    (quoteRows ?? [])
      .filter((r) => (r as { service_type: string | null }).service_type === 'permanent')
      .map((r) => {
        const row = r as { id: string; inputs: { permanent?: PermanentQuoteFields } | null };
        return [row.id, row.inputs?.permanent] as const;
      }),
  );
  // #192 — a job exists only post-booking (deposit paid — see isActiveFulfillment's
  // callers), so every active permanent quote here is always scoped to its
  // approved sides. includedPermanentSidesFromSnapshot fails open to null
  // (unscoped) on any missing/unparseable/no-match snapshot.
  const includedPermanentSidesByQuote = new Map<string, Set<PermanentSide> | null>(
    (quoteRows ?? [])
      .filter((r) => (r as { service_type: string | null }).service_type === 'permanent')
      .map((r) => {
        const row = r as { id: string; approval_snapshot: unknown };
        return [row.id, includedPermanentSidesFromSnapshot(row.approval_snapshot)] as const;
      }),
  );
  // #117 (Naldo 2026-07-11): a bistro job's THUNDER items DO auto-send on this
  // pooled PO; its Home Depot / Amazon items (posts, concrete, timer) are
  // manual buys on the per-quote order sheet (bistro-bom/print) and must never
  // reach the Thunder email. poolableBistroPoLines applies that split.
  const bistroFieldsByQuote = new Map<string, PermanentBistroInputFields | undefined>(
    (quoteRows ?? [])
      .filter((r) => (r as { service_type: string | null }).service_type === 'permanent_bistro')
      .map((r) => {
        const row = r as { id: string; inputs: { permanentBistro?: PermanentBistroInputFields } | null };
        return [row.id, row.inputs?.permanentBistro] as const;
      }),
  );
  active = active.filter((j) => !testQuoteIds.has(j.quote_id));
  if (!active.length) return { lines: [], jobCount: 0 };

  // Only fetch scenes for the NON-permanent, NON-bistro active jobs — a
  // permanent or bistro job's design scene (if any) must never feed the
  // holiday scene projection.
  const sceneQuoteIds = active
    .map((j) => j.quote_id)
    .filter((id) => !permanentFieldsByQuote.has(id) && !bistroFieldsByQuote.has(id));
  const { data: designs } = sceneQuoteIds.length
    ? await db.from('designs').select('quote_id, scene').in('quote_id', sceneQuoteIds)
    : { data: [] };
  const sceneByQuote = new Map(
    (designs ?? []).map((d) => [(d as { quote_id: string }).quote_id, (d as { scene: unknown }).scene]),
  );

  // #110 W7-009: pass clipRules through so C9 roofline clips are ordered. Dropping
  // them (passing {}) made projectClips emit sku-less lines that aggregateMaterials
  // discards — clips were never on the supplier PO despite configured SKUs.
  const { bindings, clipRules } = await getInventoryBindings();
  const needBySku = new Map<string, number>();
  for (const j of active) {
    if (permanentFieldsByQuote.has(j.quote_id)) {
      // Permanent (P8 PR-2): accumulate need from the Ascend/Dauer BOM engine —
      // no costOverrides here (the PO cares about quantities, not costs).
      // #192: scoped to the quote's approved sides.
      const bom = permanentBomFromQuote(
        { permanent: permanentFieldsByQuote.get(j.quote_id) },
        undefined,
        includedPermanentSidesByQuote.get(j.quote_id) ?? null,
      );
      for (const l of bom?.lines ?? []) {
        needBySku.set(l.sku, (needBySku.get(l.sku) ?? 0) + l.qty);
      }
      continue;
    }
    if (bistroFieldsByQuote.has(j.quote_id)) {
      // Bistro (#117): pool ONLY the Thunder-supplier lines (see
      // poolableBistroPoLines) — quantities only, costs irrelevant here.
      const bom = bistroBomFromQuote({ permanentBistro: bistroFieldsByQuote.get(j.quote_id) });
      for (const l of poolableBistroPoLines(bom?.lines ?? [])) {
        needBySku.set(l.sku, (needBySku.get(l.sku) ?? 0) + l.qty);
      }
      continue;
    }
    const scene = (sceneByQuote.get(j.quote_id) ?? { yardsticks: [], items: [] }) as Scene;
    const colorChoice = colorChoiceByQuote.get(j.quote_id) ?? null;
    for (const a of aggregateMaterials(projectMaterials(scene, bindings, clipRules, colorChoice))) {
      needBySku.set(a.sku, (needBySku.get(a.sku) ?? 0) + a.qty);
    }
  }
  if (!needBySku.size) return { lines: [], jobCount: active.length };

  const [onHandRows, onOrderBySku, catalog] = await Promise.all([listOnHand(), sumOpenOnOrder(), listCatalog()]);

  // WT-22(b): a locked (sold-out) sku must NEVER reach the supplier PO, no matter
  // which demand source produced it (holiday scene projection, permanent BOM, or
  // pooled bistro BOM) — the Overrides "lock" toggle was previously read only by
  // the catalog + a display badge, never by ordering.
  const lockedSkus = new Set(catalog.filter((c) => c.locked).map((c) => c.sku));
  for (const sku of lockedSkus) needBySku.delete(sku);
  if (!needBySku.size) return { lines: [], jobCount: active.length };

  const onHandBySku = new Map(onHandRows.map((r) => [r.sku, r.on_hand_qty]));
  const po = computePurchaseOrder(
    [...needBySku].map(([sku, needed]) => ({
      sku,
      needed,
      onHand: onHandBySku.get(sku) ?? 0,
      onOrder: onOrderBySku.get(sku) ?? 0,
    })),
  );

  const nameBySku = new Map(catalog.map((c) => [c.sku, c.name]));
  // #117 follow-up (WT-27): bistro's SKUs live in the STATIC bistro catalog (no
  // inventory_catalog rows exist for them), so backfill their display names —
  // mirrors jobs.ts's same backfill — before this map fed the real supplier PO
  // email, every pooled bistro SKU fell to '(not in catalog)'. A DB row with the
  // same SKU still wins (only set when not already present).
  for (const item of BISTRO_CATALOG) {
    if (!nameBySku.has(item.sku)) nameBySku.set(item.sku, item.name);
  }
  return {
    lines: po.map((l) => ({ ...l, name: nameBySku.get(l.sku) ?? '(not in catalog)' })),
    jobCount: active.length,
  };
}

// ── Email the PO to the supplier (shared by the manual route + the cron) ─────
export type SendResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * Email the PO to the supplier AND record it on the on-order ledger (P8, folds
 * in #110 W7-002). Insert-first: the order is recorded BEFORE the send, so the
 * worst failure mode is under-ordering (the send never happens, the shortfall
 * reappears next time, and staff sees a stuck open order to cancel) rather than
 * an unrecorded send that could double-ship later. On a successful send the row
 * is stamped sent; on a failed send it's best-effort cancelled so it doesn't sit
 * around as a phantom open order skewing the next delta calc.
 */
export async function emailSupplierPurchaseOrder(
  po: SupplierPurchaseOrder,
  date: string,
  channel: InventoryOrder['channel'],
): Promise<SendResult> {
  const contactId = process.env.THUNDER_ORDER_CONTACT_ID;
  if (!isHighLevelConfigured() || !contactId) {
    return { ok: false, status: 503, error: 'Supplier order email not configured — needs HighLevel + THUNDER_ORDER_CONTACT_ID' };
  }

  const orderId = await recordOrder({
    channel,
    lines: po.lines.map((l) => ({ sku: l.sku, name: l.name, qty: l.order })),
    jobCount: po.jobCount,
  });
  if (!orderId) {
    return { ok: false, status: 500, error: 'Could not record the order — not sent.' };
  }

  // Concurrent-send guard: two send paths (the cron + the deposit-webhook
  // trigger) can build the same delta simultaneously — both would record and
  // email it, and now that orders are additive (no "replaces prior order"
  // disclaimer) the supplier would ship both. After inserting OUR row, re-sum
  // the open orders: if on-hand + the OTHER open orders already cover every
  // line's need, ours is a duplicate — cancel it and skip the send. When both
  // racers detect each other they both cancel, which under-orders and
  // self-heals on the next build (the accepted failure direction; never
  // double-ship).
  const openAfter = await sumOpenOnOrder();
  const redundant =
    po.lines.length > 0 &&
    po.lines.every((l) => {
      const others = Math.max(0, (openAfter.get(l.sku) ?? 0) - l.order);
      return l.onHand + others >= l.needed;
    });
  if (redundant) {
    await cancelOrder(orderId); // best-effort — a stuck open order is staff-visible
    return { ok: false, status: 409, error: 'Duplicate order — an order covering this need was just recorded. Nothing sent.' };
  }

  try {
    await sendEmail({
      contactId,
      subject: supplierOrderEmailSubject(po.jobCount, date),
      html: supplierOrderEmailHtml({
        lines: po.lines.map((l) => ({ sku: l.sku, name: l.name, order: l.order })),
        jobCount: po.jobCount,
        date,
      }),
      emailFrom: process.env.HIGHLEVEL_EMAIL_FROM || undefined,
    });
    await markOrderSent(orderId);
    // #82 follow-up — proactive ping to the inventory group with what was ordered.
    // Best-effort: a ping failure must not flip a successful send into an error.
    try {
      await notifyTelegramAudience(
        'inventory',
        poSentMessage({
          lines: po.lines.map((l) => ({ name: l.name, sku: l.sku, order: l.order })),
          jobCount: po.jobCount,
          baseUrl: appBaseUrl(),
        }),
      );
    } catch (err) {
      console.error('emailSupplierPurchaseOrder: PO sent ping failed:', err);
    }
    return { ok: true };
  } catch (err) {
    console.error('emailSupplierPurchaseOrder failed:', err);
    await cancelOrder(orderId); // best-effort — don't leave a phantom open order
    return { ok: false, status: 502, error: 'Failed to send the order email' };
  }
}

// ── Unattended auto-send dedup (#82 optional) ────────────────────────────────
// A stable signature of the order so the weekly cron never re-emails an UNCHANGED
// PO. Stored in app_settings; reset to '' once the shortfall clears so a
// re-appearing shortfall sends again. The P8 on-order ledger is now the PRIMARY
// guard against duplicate/runaway ordering (it makes the computed order itself a
// delta); this signature dedup is a belt-and-braces second layer that also
// avoids emailing the supplier again for a truly unchanged order.
export function purchaseOrderSignature(lines: { sku: string; order: number }[]): string {
  return lines
    .map((l) => `${l.sku}:${l.order}`)
    .sort()
    .join('|');
}

const AUTO_SEND_KEY = 'po_auto_send_last';

export async function getLastAutoSentSignature(): Promise<string | null> {
  const db = getSupabaseServiceClient();
  if (!db) return null;
  const { data } = await db.from('app_settings').select('value').eq('key', AUTO_SEND_KEY).maybeSingle();
  const sig = (data as { value?: { signature?: unknown } } | null)?.value?.signature;
  return typeof sig === 'string' ? sig : null;
}

export async function recordAutoSentSignature(signature: string): Promise<void> {
  const db = getSupabaseServiceClient();
  if (!db) return;
  await db
    .from('app_settings')
    .upsert({ key: AUTO_SEND_KEY, value: { signature, sentAt: new Date().toISOString() } }, { onConflict: 'key' });
}

// ── Event-driven auto-PO trigger (Naldo rule: send when ≥N booked jobs) ──────
// Called from the deposit-paid Valor webhook. The scheduled cron handles the
// every-3-days send; this gives an extra send whenever the active-job count
// reaches the busy threshold (default 5 = "more than 4 installs"). Honors the
// same gates as the cron: PO_AUTO_SEND_ENABLED flag, supplier-contact config,
// and the signature dedup so we never re-email an unchanged order.
//
// Best-effort — the caller (webhook) is expected to swallow exceptions; we
// already log internally and return a structured result rather than throwing.

export type AutoPOTriggerResult =
  | { ok: true; fired: true; signature: string; jobCount: number; items: number }
  | { ok: true; fired: false; reason: string }
  | { ok: false; status: number; error: string };

export async function triggerAutoPOIfBusy(opts: { minJobCount: number }): Promise<AutoPOTriggerResult> {
  if (process.env.PO_AUTO_SEND_ENABLED !== 'true') {
    return { ok: true, fired: false, reason: 'auto-send disabled' };
  }
  const po = await buildSupplierPurchaseOrder();
  if (po.jobCount < opts.minJobCount) {
    return { ok: true, fired: false, reason: `${po.jobCount} job(s) < threshold ${opts.minJobCount}` };
  }
  if (!po.lines.length) {
    return { ok: true, fired: false, reason: 'nothing to order' };
  }
  const sig = purchaseOrderSignature(po.lines);
  if (sig === (await getLastAutoSentSignature())) {
    return { ok: true, fired: false, reason: 'unchanged since last send' };
  }
  const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const res = await emailSupplierPurchaseOrder(po, date, 'auto-webhook');
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  await recordAutoSentSignature(sig);
  return { ok: true, fired: true, signature: sig, jobCount: po.jobCount, items: po.lines.length };
}
