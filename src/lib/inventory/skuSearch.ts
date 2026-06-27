// src/lib/inventory/skuSearch.ts
// Pure catalog filter for the SKU picker (1b-ii) + the overrides item list
// (1b-iii). Matches the query against sku, product name, and effective category
// (yll_category override else vendor category), case-insensitive. Empty query →
// the first `limit` items (so the picker shows something on focus).

import type { CatalogItem } from './catalog';

export function searchCatalog(items: CatalogItem[], query: string, limit = 50): CatalogItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const out: CatalogItem[] = [];
  for (const it of items) {
    const cat = (it.yll_category ?? it.category).toLowerCase();
    if (it.sku.toLowerCase().includes(q) || it.name.toLowerCase().includes(q) || cat.includes(q)) {
      out.push(it);
      if (out.length >= limit) break;
    }
  }
  return out;
}
