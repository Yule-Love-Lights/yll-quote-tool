// src/lib/inventory/skuSearch.ts
// Pure catalog filter for the SKU picker (1b-ii) + the overrides item list
// (1b-iii). Matches the query against sku, product name, and effective category
// (yll_category override else vendor category), case-insensitive. Empty query →
// the first `limit` items (so the picker shows something on focus).
//
// WT-23: an optional `hiddenCategories` list (the operator's Hide-category
// overrides, catalog.ts's `getHiddenCategories`) drops matching items BEFORE
// the query filter, so a hidden category never surfaces in a SKU picker.
// Omitted/empty ⇒ no filtering, same as before — callers that need the FULL
// catalog (e.g. the overrides "items" tab, so staff can still manage a hidden
// category's items) simply don't pass it.

import type { CatalogItem } from './catalog';
import { effectiveCategory } from './catalog';

export function searchCatalog(
  items: CatalogItem[],
  query: string,
  limit = 50,
  hiddenCategories: string[] = [],
): CatalogItem[] {
  const hidden = hiddenCategories.length ? new Set(hiddenCategories) : null;
  const visible = hidden ? items.filter((it) => !hidden.has(effectiveCategory(it))) : items;
  const q = query.trim().toLowerCase();
  if (!q) return visible.slice(0, limit);
  const out: CatalogItem[] = [];
  for (const it of visible) {
    const cat = effectiveCategory(it).toLowerCase();
    if (it.sku.toLowerCase().includes(q) || it.name.toLowerCase().includes(q) || cat.includes(q)) {
      out.push(it);
      if (out.length >= limit) break;
    }
  }
  return out;
}
