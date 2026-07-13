// src/lib/inventory/catalog.ts
// Supabase data layer for the supplier catalog (#82 Slice 1a). Service-role
// only (admin/server), mirroring src/lib/quotes.ts. Reads swallow errors to []
// so the page renders before the migration lands; writes throw.

import { getSupabaseServiceClient, getSupabaseClient } from '../supabase';
import type { ParsedCatalogItem } from './parseThunderCsv';
import { costOverridesFromCatalog } from './ascendCatalog';

export type CatalogItem = ParsedCatalogItem & {
  yll_category: string | null; // operator override (1b); null → use `category`
  locked: boolean;             // operator sold-out flag (1b/1c)
};

const SELECT =
  'sku, name, category, yll_category, color, size, wholesale_cost, needs_adapter, bag_ct, case_ct, locked';

export async function listCatalog(): Promise<CatalogItem[]> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('inventory_catalog')
    .select(SELECT)
    .order('category', { ascending: true })
    .order('name', { ascending: true });
  if (error) {
    console.error('listCatalog error:', error);
    return [];
  }
  return (data ?? []) as CatalogItem[];
}

// P8 PR-2 — live catalog costs for buildPermanentBom's costOverrides hook (SKU →
// wholesale_cost). A read failure already swallows to [] inside listCatalog, so
// this degrades to an empty map → every SKU falls back to the BOM engine's own
// built-in cost; callers never need their own try/catch for this.
export async function catalogCostOverrides(): Promise<Map<string, number>> {
  return costOverridesFromCatalog(await listCatalog());
}

// Pure: the EXACT column set an import upsert writes. yll_category + locked are
// deliberately excluded so a yearly re-import re-seeds prices/names without
// clobbering operator regrouping or sold-out flags. Pinned by catalog.test.ts.
export function toCatalogUpsertRow(item: ParsedCatalogItem): ParsedCatalogItem {
  return {
    sku: item.sku,
    name: item.name,
    category: item.category,
    color: item.color,
    size: item.size,
    wholesale_cost: item.wholesale_cost,
    needs_adapter: item.needs_adapter,
    bag_ct: item.bag_ct,
    case_ct: item.case_ct,
  };
}

// Upsert ONLY vendor-sourced columns (see toCatalogUpsertRow).
export async function upsertCatalogItems(items: ParsedCatalogItem[]): Promise<number> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  if (items.length === 0) return 0;
  const rows = items.map(toCatalogUpsertRow);
  const { error, count } = await sb
    .from('inventory_catalog')
    .upsert(rows, { onConflict: 'sku', count: 'exact' });
  if (error) throw new Error(`upsertCatalogItems: ${error.message}`);
  return count ?? rows.length;
}

// ── operator overrides (1b-iii) ──────────────────────────────────────────────

// Update one catalog row's operator-owned fields (sold-out lock + regroup).
export async function updateCatalogItem(
  sku: string,
  patch: { locked?: boolean; yll_category?: string | null },
): Promise<void> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  const update: Record<string, unknown> = {};
  if (typeof patch.locked === 'boolean') update.locked = patch.locked;
  // yll_category: a string regroups; null clears back to the vendor category.
  if (patch.yll_category !== undefined) {
    update.yll_category =
      typeof patch.yll_category === 'string' && patch.yll_category.trim()
        ? patch.yll_category.trim()
        : null;
  }
  if (Object.keys(update).length === 0) return;
  const { error } = await sb.from('inventory_catalog').update(update).eq('sku', sku);
  if (error) throw new Error(`updateCatalogItem: ${error.message}`);
}

// Effective category name — the operator's yll_category override wins over the
// vendor category. hiddenCategories stores THESE names (see the note on
// getHiddenCategories below), so any hide-category filter (searchCatalog,
// WT-23) must key off this same formula or the hide will silently miss.
export function effectiveCategory(item: Pick<CatalogItem, 'category' | 'yll_category'>): string {
  return item.yll_category ?? item.category;
}

// Category show/hide list (Q6.3) — an app_settings key, parallel to bindings.
export function normalizeHiddenCategories(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  for (const x of v) {
    if (typeof x === 'string' && x.trim()) seen.add(x.trim());
  }
  return [...seen];
}

// NOTE: stores EFFECTIVE category names (yll_category ?? category). The Slice 2
// materials engine must compute the same effective category to honor hides.
export async function getHiddenCategories(): Promise<string[]> {
  const sb = getSupabaseServiceClient(); // service-only config read, like getInventoryBindings
  if (!sb) return [];
  const { data, error } = await sb
    .from('app_settings')
    .select('value')
    .eq('key', 'hiddenCategories')
    .maybeSingle();
  if (error) {
    console.error('getHiddenCategories error:', error);
    return [];
  }
  return normalizeHiddenCategories(data?.value);
}

export async function setHiddenCategories(cats: string[]): Promise<string[]> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  const value = normalizeHiddenCategories(cats);
  const { error } = await sb
    .from('app_settings')
    .upsert({ key: 'hiddenCategories', value }, { onConflict: 'key' });
  if (error) throw new Error(`setHiddenCategories: ${error.message}`);
  return value;
}
