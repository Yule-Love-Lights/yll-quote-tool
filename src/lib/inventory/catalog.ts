// src/lib/inventory/catalog.ts
// Supabase data layer for the supplier catalog (#82 Slice 1a). Service-role
// only (admin/server), mirroring src/lib/quotes.ts. Reads swallow errors to []
// so the page renders before the migration lands; writes throw.

import { getSupabaseServiceClient, getSupabaseClient } from '../supabase';
import type { ParsedCatalogItem } from './parseThunderCsv';

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

// Upsert ONLY vendor-sourced columns (the ParsedCatalogItem shape). yll_category
// and locked are intentionally absent from the payload, so a yearly re-import
// re-seeds prices/names without clobbering operator regrouping or sold-out flags.
export async function upsertCatalogItems(items: ParsedCatalogItem[]): Promise<number> {
  const sb = getSupabaseServiceClient();
  if (!sb) throw new Error('Supabase service role not configured');
  if (items.length === 0) return 0;
  const { error, count } = await sb
    .from('inventory_catalog')
    .upsert(items, { onConflict: 'sku', count: 'exact' });
  if (error) throw new Error(`upsertCatalogItems: ${error.message}`);
  return count ?? items.length;
}
