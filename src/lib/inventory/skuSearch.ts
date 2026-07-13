// src/lib/inventory/skuSearch.ts
// Pure catalog filter for the SKU picker (1b-ii) + the overrides item list
// (1b-iii). Matches the query against sku, product name, and effective category
// (yll_category override else vendor category), case-insensitive. Empty query →
// the first `limit` items (so the picker shows something on focus).
//
// WT-23: `hiddenCategories` (the Overrides categories tab's show/hide list, keyed
// by EFFECTIVE category — see catalog.ts's getHiddenCategories comment) is
// applied FIRST, before the query, so a hidden category's skus vanish from both
// the SkuPicker and the Overrides items tab, exactly like the categories tab
// promises. Optional + defaults to none hidden — old callers are unaffected.

import type { CatalogItem } from './catalog';

export function searchCatalog(
  items: CatalogItem[],
  query: string,
  limit = 50,
  hiddenCategories: readonly string[] = [],
): CatalogItem[] {
  const hidden = hiddenCategories.length ? new Set(hiddenCategories) : null;
  const visible = hidden ? items.filter((it) => !hidden.has(it.yll_category ?? it.category)) : items;
  const q = query.trim().toLowerCase();
  if (!q) return visible.slice(0, limit);
  const out: CatalogItem[] = [];
  for (const it of visible) {
    const cat = (it.yll_category ?? it.category).toLowerCase();
    if (it.sku.toLowerCase().includes(q) || it.name.toLowerCase().includes(q) || cat.includes(q)) {
      out.push(it);
      if (out.length >= limit) break;
    }
  }
  return out;
}
