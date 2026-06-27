// src/lib/inventory/catalog.test.ts
import { describe, it, expect } from 'vitest';
import { toCatalogUpsertRow, normalizeHiddenCategories } from './catalog';
import type { ParsedCatalogItem } from './parseThunderCsv';

const SAMPLE: ParsedCatalogItem = {
  sku: '14147', name: 'C9 Flex Clip White', category: 'Hardware', color: 'White',
  size: null, wholesale_cost: 0.18, needs_adapter: false, bag_ct: 100, case_ct: 800,
};

describe('toCatalogUpsertRow', () => {
  // CARRY-FORWARD: re-import must NEVER write the operator-owned columns
  // (locked / yll_category), or a yearly re-import would clobber overrides.
  it('writes exactly the vendor columns — no locked / yll_category', () => {
    expect(Object.keys(toCatalogUpsertRow(SAMPLE)).sort()).toEqual(
      ['bag_ct', 'case_ct', 'category', 'color', 'name', 'needs_adapter', 'size', 'sku', 'wholesale_cost'].sort(),
    );
  });
  it('drops any stray operator fields a caller passes in', () => {
    const dirty = { ...SAMPLE, locked: true, yll_category: 'Clips' } as ParsedCatalogItem;
    const row = toCatalogUpsertRow(dirty) as Record<string, unknown>;
    expect(row.locked).toBeUndefined();
    expect(row.yll_category).toBeUndefined();
  });
});

describe('normalizeHiddenCategories', () => {
  it('keeps non-empty trimmed strings, de-duped', () => {
    expect(normalizeHiddenCategories(['Bulbs', ' Bulbs ', 'Wire', ''])).toEqual(['Bulbs', 'Wire']);
  });
  it('returns [] for non-array / garbage input', () => {
    expect(normalizeHiddenCategories(null)).toEqual([]);
    expect(normalizeHiddenCategories('x')).toEqual([]);
    expect(normalizeHiddenCategories([1, 2, {}])).toEqual([]);
  });
});
