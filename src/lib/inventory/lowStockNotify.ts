// src/lib/inventory/lowStockNotify.ts
// Dedup state for the proactive low-stock Telegram ping (#82 follow-up). The daily
// low-stock cron computes the full low set; we only ping the SKUs that NEWLY went
// low since the last run, so a SKU that stays low isn't re-nagged. A SKU that
// recovers drops from the stored set, so it can ping again if it goes low later.
// State is a single app_settings key (no migration), mirroring the PO auto-send
// signature in purchaseOrder.ts.

import { getSupabaseServiceClient } from '../supabase';

// Pure: the SKUs low now that weren't in the last-notified set, in current order.
export function newlyLowSkus(currentLow: string[], lastNotified: string[]): string[] {
  const last = new Set(lastNotified);
  return currentLow.filter((sku) => !last.has(sku));
}

const LOW_NOTIFY_KEY = 'low_stock_notify_last';

export async function getLastLowStockNotified(): Promise<string[]> {
  const db = getSupabaseServiceClient();
  if (!db) return [];
  const { data } = await db.from('app_settings').select('value').eq('key', LOW_NOTIFY_KEY).maybeSingle();
  const skus = (data as { value?: { skus?: unknown } } | null)?.value?.skus;
  return Array.isArray(skus) ? skus.filter((s): s is string => typeof s === 'string') : [];
}

export async function recordLowStockNotified(skus: string[]): Promise<void> {
  const db = getSupabaseServiceClient();
  if (!db) return;
  await db
    .from('app_settings')
    .upsert({ key: LOW_NOTIFY_KEY, value: { skus, at: new Date().toISOString() } }, { onConflict: 'key' });
}
