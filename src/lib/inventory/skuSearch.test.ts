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

  // WT-23: a hidden category (the operator's Overrides toggle) drops out of
  // search results entirely — a picker should never surface a SKU staff
  // deliberately hid.
  it('excludes items whose EFFECTIVE category is hidden', () => {
    expect(searchCatalog(CATALOG, '', 10, ['Hardware']).map((i) => i.sku)).toEqual(['20009-SPK']);
    expect(searchCatalog(CATALOG, 'c9', 10, ['Hardware']).map((i) => i.sku)).toEqual(['20009-SPK']);
  });

  it('hidden-category filtering respects the yll_category override, not just the vendor category', () => {
    const regrouped = [
      ...CATALOG,
      item({ sku: '99999', name: 'Regrouped Clip', category: 'Hardware', yll_category: 'Clips' }),
    ];
    // Hiding the EFFECTIVE category "Clips" only drops the regrouped item, not
    // the rest of "Hardware".
    expect(searchCatalog(regrouped, '', 10, ['Clips']).map((i) => i.sku)).toEqual(['20009-SPK', '14147', '14148']);
  });

  it('an empty hiddenCategories list filters nothing (default, backward compatible)', () => {
    expect(searchCatalog(CATALOG, '', 10, [])).toHaveLength(3);
  });
});
