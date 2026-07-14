// src/lib/inventory/bistroCatalog.test.ts
// Lock-in test (mirrors ascendCatalog.test.ts): sweeps buildBistroBom across a
// range of footage/pole configs and asserts every SKU the BOM engine can ever
// emit (a) exists in BISTRO_CATALOG and (b) carries the SAME fallback unit
// cost as the engine's own built-in fallback. Catches drift in either
// direction — a catalog cost that goes stale vs the engine, or an engine SKU
// the catalog forgot to seed.

import { describe, it, expect } from 'vitest';
import { buildBistroBom, type BistroBomInput } from '../permanentBistro/bom';
import { BISTRO_CATALOG, costOverridesFromBistroCatalog } from './bistroCatalog';

const SWEEP_INPUTS: BistroBomInput[] = [
  { runs: [40, 35, 25], poles: 2 }, // the worked example — footage + strands + poles
  { runs: [], poles: 3 }, // poles-only
  { runs: [340], poles: 0 }, // footage-only, multi-section
];

function collectAllEmittedSkus(): Map<string, number> {
  const skuCosts = new Map<string, number>();
  for (const input of SWEEP_INPUTS) {
    const bom = buildBistroBom(input); // no overrides — the engine's own fallback costs
    for (const l of bom.lines) skuCosts.set(l.sku, l.unitCost);
  }
  return skuCosts;
}

describe('BISTRO_CATALOG — lock-in against the BOM engine', () => {
  it('has no duplicate SKUs', () => {
    const skus = BISTRO_CATALOG.map((c) => c.sku);
    expect(new Set(skus).size).toBe(skus.length);
  });

  it('every SKU the BOM engine can emit exists in BISTRO_CATALOG with the SAME fallback cost', () => {
    const emitted = collectAllEmittedSkus();
    expect(emitted.size).toBeGreaterThan(0); // sanity — the sweep actually produced lines

    const catalogBySku = new Map(BISTRO_CATALOG.map((c) => [c.sku, c.unitCost]));
    const missing: string[] = [];
    const mismatched: { sku: string; engine: number; catalog: number | undefined }[] = [];
    for (const [sku, engineCost] of emitted) {
      if (!catalogBySku.has(sku)) {
        missing.push(sku);
        continue;
      }
      const catalogCost = catalogBySku.get(sku);
      if (catalogCost === undefined || Math.abs(catalogCost - engineCost) > 1e-6) {
        mismatched.push({ sku, engine: engineCost, catalog: catalogCost });
      }
    }
    expect(missing).toEqual([]);
    expect(mismatched).toEqual([]);
  });
});

describe('costOverridesFromBistroCatalog', () => {
  it('builds sku → wholesale_cost, skipping null/non-finite/<=0 rows', () => {
    const map = costOverridesFromBistroCatalog([
      { sku: 'A', wholesale_cost: 1.5 },
      { sku: 'B', wholesale_cost: null },
      { sku: 'C', wholesale_cost: 0 },
      { sku: 'D', wholesale_cost: -5 },
      { sku: 'E', wholesale_cost: NaN },
      { sku: 'F', wholesale_cost: 10 },
    ]);
    expect([...map.entries()]).toEqual([['A', 1.5], ['F', 10]]);
  });

  it('returns an empty map for an empty catalog', () => {
    expect(costOverridesFromBistroCatalog([]).size).toBe(0);
  });
});
