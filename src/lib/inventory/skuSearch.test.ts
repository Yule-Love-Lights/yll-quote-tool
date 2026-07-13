// src/lib/inventory/skuSearch.test.ts
import { describe, it, expect } from 'vitest';
import { searchCatalog } from './skuSearch';
import type { CatalogItem } from './catalog';

const item = (over: Partial<CatalogItem>): CatalogItem => ({
  sku: '0', name: 'x', category: 'Cat', yll_category: null, color: null, size: null,
  wholesale_cost: null, needs_adapter: false, bag_ct: null, case_ct: null, locked: false,
  ...over,
});

const CATALOG: CatalogItem[] = [
  item({ sku: '20009-SPK', name: 'C9 Warm White', category: 'Bulbs' }),
  item({ sku: '14147', name: 'C9 Flex Clip White', category: 'Hardware' }),
  item({ sku: '14148', name: 'C9 Tuff Tab', category: 'Hardware' }),
];

describe('searchCatalog', () => {
  it('returns the first `limit` items for an empty query', () => {
    expect(searchCatalog(CATALOG, '', 2)).toHaveLength(2);
    expect(searchCatalog(CATALOG, '   ', 2)).toHaveLength(2);
  });
  it('matches sku, name, or category, case-insensitively', () => {
    expect(searchCatalog(CATALOG, '14147').map((i) => i.sku)).toEqual(['14147']);
    expect(searchCatalog(CATALOG, 'warm white').map((i) => i.sku)).toEqual(['20009-SPK']);
    expect(searchCatalog(CATALOG, 'HARDWARE').map((i) => i.sku)).toEqual(['14147', '14148']);
  });
  it('respects the result limit', () => {
    expect(searchCatalog(CATALOG, 'c9', 1)).toHaveLength(1);
  });
});

// WT-23: "hiddenCategories" was written by the Overrides categories tab but read
// back only to re-render that toggle — searchCatalog never honored it, so a
// "hidden" category still showed up in both the SkuPicker and the Overrides items
// tab. It must vanish from both, which both call through searchCatalog.
describe('searchCatalog — WT-23 hidden categories', () => {
  it('excludes every sku whose effective category is hidden', () => {
    expect(searchCatalog(CATALOG, '', 50, ['Hardware']).map((i) => i.sku)).toEqual(['20009-SPK']);
  });
  it('a hidden category is excluded even when the query would otherwise match it', () => {
    expect(searchCatalog(CATALOG, 'HARDWARE', 50, ['Hardware'])).toEqual([]);
  });
  it('honors the yll_category override, not the vendor category, when hiding', () => {
    const regrouped = [...CATALOG, item({ sku: '99999', name: 'Regrouped item', category: 'Bulbs', yll_category: 'Hardware' })];
    // Hiding "Hardware" hides the regrouped item (effective category), even
    // though its vendor category is "Bulbs".
    const skus = searchCatalog(regrouped, '', 50, ['Hardware']).map((i) => i.sku);
    expect(skus).not.toContain('99999');
  });
  it('an empty hiddenCategories list keeps the old behavior (backward compatible)', () => {
    expect(searchCatalog(CATALOG, '', 50, []).map((i) => i.sku)).toEqual(CATALOG.map((i) => i.sku));
  });
});
