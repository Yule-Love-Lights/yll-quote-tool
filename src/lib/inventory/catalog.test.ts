// src/lib/inventory/catalog.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ParsedCatalogItem } from './parseThunderCsv';

// catalogCostOverrides() is listCatalog() piped through costOverridesFromCatalog
// (ascendCatalog.ts) — mock the Supabase client so listCatalog resolves from a
// fake `inventory_catalog` select rather than needing real config.
let catalogRows: Record<string, unknown>[] = [];
vi.mock('../supabase', () => ({
  getSupabaseServiceClient: () => ({
    from: () => ({
      select: () => ({
        order: () => ({
          order: async () => ({ data: catalogRows, error: null }),
        }),
      }),
    }),
  }),
  getSupabaseClient: () => null,
}));

const { toCatalogUpsertRow, normalizeHiddenCategories, catalogCostOverrides } = await import('./catalog');

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

describe('catalogCostOverrides', () => {
  beforeEach(() => {
    catalogRows = [];
  });

  it('listCatalog() piped through costOverridesFromCatalog', async () => {
    catalogRows = [
      { sku: 'APL11012-5', wholesale_cost: 15.5156316 },
      { sku: 'APL11012-1', wholesale_cost: null }, // no usable price — skipped
    ];
    const map = await catalogCostOverrides();
    expect([...map.entries()]).toEqual([['APL11012-5', 15.5156316]]);
  });

  it('returns an empty map when the catalog is empty', async () => {
    catalogRows = [];
    const map = await catalogCostOverrides();
    expect(map.size).toBe(0);
  });
});
