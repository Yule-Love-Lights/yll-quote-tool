// src/lib/inventory/purchaseOrder.ts
// Auto purchase-order generator (#82 Phase 3 — "AI auto-ordering", email channel).
// DEMAND-DRIVEN + deterministic: aggregate the material needs of the active,
// not-yet-prepped jobs, subtract on-hand, and the positive shortfall is what to
// order from the supplier. No arbitrary reorder target, no LLM — the design→SKU
// projection is the intelligence. The actual SEND is human-gated (staff click) —
// The manual send is human-gated (staff click). An OPTIONAL unattended cron
// auto-send exists too (off by default behind PO_AUTO_SEND_ENABLED), with a
// signature dedup so it never re-sends an unchanged order.

import { getSupabaseServiceClient } from '../supabase';
import type { Scene } from '@/lib/design/sceneTypes';
import { getInventoryBindings } from './bindings';
import { listCatalog } from './catalog';
import { listOnHand } from './onHand';
import { projectMaterials, aggregateMaterials } from './materialsProjection';
import { colorChoiceFromSnapshot } from './resolveInstalls';
import { isActiveFulfillment } from './jobs';
import { isHighLevelConfigured, sendEmail } from '@/lib/integrations/highlevel';
import { supplierOrderEmailSubject, supplierOrderEmailHtml } from '@/lib/integrations/quoteMessages';
import { notifyTelegram, appBaseUrl } from '@/lib/integrations/telegramNotify';
import { poSentMessage } from '@/lib/integrations/telegramMessages';

export type POInput = { sku: string; needed: number; onHand: number };
export type POLine = { sku: string; needed: number; onHand: number; order: number };

// Pure: per SKU, order the shortfall = ceil(need) − on-hand (floored at 0). Drops
// anything already covered by stock; sorted by SKU for a stable order sheet.
export function computePurchaseOrder(items: POInput[]): POLine[] {
  return items
    .map((i) => {
      const needed = Math.max(0, Math.ceil(i.needed));
      const onHand = Math.max(0, i.onHand);
      return { sku: i.sku, needed, onHand, order: Math.max(0, needed - onHand) };
    })
    .filter((l) => l.order > 0)
    .sort((a, b) => a.sku.localeCompare(b.sku));
}

export type PurchaseOrderLine = POLine & { name: string };
export type SupplierPurchaseOrder = { lines: PurchaseOrderLine[]; jobCount: number };

/**
 * Build the supplier purchase order from current demand: every active job that
 * hasn't been prepped yet (its stock isn't deducted), aggregated and compared to
 * on-hand. Only bound SKUs are orderable (unbound concepts have no SKU). Returns
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
  const allQuoteIds = [...new Set(active.map((j) => j.quote_id))];
  const { data: quoteRows } = await db
    .from('quotes')
    .select('id, is_test, approval_snapshot')
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
  active = active.filter((j) => !testQuoteIds.has(j.quote_id));
  if (!active.length) return { lines: [], jobCount: 0 };

  const quoteIds = [...new Set(active.map((j) => j.quote_id))];
  const { data: designs } = await db.from('designs').select('quote_id, scene').in('quote_id', quoteIds);
  const sceneByQuote = new Map(
    (designs ?? []).map((d) => [(d as { quote_id: string }).quote_id, (d as { scene: unknown }).scene]),
  );

  const { bindings } = await getInventoryBindings();
  const needBySku = new Map<string, number>();
  for (const j of active) {
    const scene = (sceneByQuote.get(j.quote_id) ?? { yardsticks: [], items: [] }) as Scene;
    const colorChoice = colorChoiceByQuote.get(j.quote_id) ?? null;
    for (const a of aggregateMaterials(projectMaterials(scene, bindings, {}, colorChoice))) {
      needBySku.set(a.sku, (needBySku.get(a.sku) ?? 0) + a.qty);
    }
  }
  if (!needBySku.size) return { lines: [], jobCount: active.length };

  const onHandBySku = new Map((await listOnHand()).map((r) => [r.sku, r.on_hand_qty]));
  const po = computePurchaseOrder(
    [...needBySku].map(([sku, needed]) => ({ sku, needed, onHand: onHandBySku.get(sku) ?? 0 })),
  );

  const nameBySku = new Map((await listCatalog()).map((c) => [c.sku, c.name]));
  return {
    lines: po.map((l) => ({ ...l, name: nameBySku.get(l.sku) ?? '(not in catalog)' })),
    jobCount: active.length,
  };
}

// ── Email the PO to the supplier (shared by the manual route + the cron) ─────
export type SendResult = { ok: true } | { ok: false; status: number; error: string };

export async function emailSupplierPurchaseOrder(po: SupplierPurchaseOrder, date: string): Promise<SendResult> {
  const contactId = process.env.THUNDER_ORDER_CONTACT_ID;
  if (!isHighLevelConfigured() || !contactId) {
    return { ok: false, status: 503, error: 'Supplier order email not configured — needs HighLevel + THUNDER_ORDER_CONTACT_ID' };
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
    // #82 follow-up — proactive ping to the inventory group with what was ordered.
    // Best-effort: a ping failure must not flip a successful send into an error.
    try {
      await notifyTelegram(
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
    return { ok: false, status: 502, error: 'Failed to send the order email' };
  }
}

// ── Unattended auto-send dedup (#82 optional) ────────────────────────────────
// A stable signature of the order so the weekly cron never re-emails an UNCHANGED
// PO. Stored in app_settings; reset to '' once the shortfall clears so a
// re-appearing shortfall sends again.
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
  const res = await emailSupplierPurchaseOrder(po, date);
  if (!res.ok) return { ok: false, status: res.status, error: res.error };
  await recordAutoSentSignature(sig);
  return { ok: true, fired: true, signature: sig, jobCount: po.jobCount, items: po.lines.length };
}
