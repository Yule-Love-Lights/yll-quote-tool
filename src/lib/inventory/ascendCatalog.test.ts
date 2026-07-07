// src/lib/inventory/ascendCatalog.test.ts
// P8 PR-2: the lock-in test. Sweeps buildPermanentBom across the full input
// space (every trackStyle × trackColor × blackHousing, plus configs that force
// boosters/splitters/power-T/every extension tier/both transformer sizes/kits)
// and asserts every SKU the BOM engine can ever emit (a) exists in
// ASCEND_CATALOG and (b) carries the SAME wholesale_cost as the engine's own
// built-in fallback (read from the BOM lines built WITHOUT overrides). This
// catches drift in either direction — a catalog cost that goes stale vs the
// engine, or an engine SKU the catalog forgot to seed.

import { describe, it, expect } from 'vitest';
import { buildPermanentBom, type PermanentBomInput } from '../permanent/bom';
import type { TrackStyle, TrackColor } from '../permanent/types';
import { ASCEND_CATALOG, costOverridesFromCatalog } from './ascendCatalog';

const TRACK_STYLES: TrackStyle[] = ['single', 'parapet'];
const TRACK_COLORS: TrackColor[] = ['9003', '9004', '9012', '8019'];

// Sweep configs designed to hit every branch: corners (singles), gaps at every
// stock extension size (3/5/10/25/50 + a >50 combo), a splitter gap, a >10ft
// controller run (booster), and enough footage to trigger power injection.
function sweepInputs(trackStyle: TrackStyle, trackColor: TrackColor, blackHousing: boolean): PermanentBomInput[] {
  const base = {
    footageBySide: { front: 125, left: 40, right: 40, back: 60 },
    cornersBySide: { front: 3, left: 1, right: 1, back: 2 },
    trackStyle,
    trackColor,
    blackHousing,
    controllerToFirstLightFt: 35,
    gaps: [
      { lengthFt: 3 },
      { lengthFt: 5 },
      { lengthFt: 10 },
      { lengthFt: 25, splitter: true },
      { lengthFt: 50 },
      { lengthFt: 60 }, // combines into 50' + 10'
    ],
  };
  return [base];
}

// Additional configs to force both transformer wattages, the bare-supply
// consolidation path, and a range of puck counts around the 255/433 caps.
const TRANSFORMER_SWEEP_LIGHTS = [1, 50, 188, 255, 256, 300, 433, 434, 500, 600, 866, 1050];

function collectAllEmittedSkus(): Map<string, number> {
  const skuCosts = new Map<string, number>();
  const record = (input: PermanentBomInput) => {
    const bom = buildPermanentBom(input); // no overrides — the engine's own fallback costs
    for (const l of bom.lines) skuCosts.set(l.sku, l.unitCost);
  };

  for (const trackStyle of TRACK_STYLES) {
    for (const trackColor of TRACK_COLORS) {
      for (const blackHousing of [false, true]) {
        for (const input of sweepInputs(trackStyle, trackColor, blackHousing)) record(input);
      }
    }
  }

  // Large single-run job → 600W transformers + duplicate bare-supply consolidation.
  record({
    footageBySide: { front: 800, left: 0, right: 0, back: 0 },
    cornersBySide: { front: 0, left: 0, right: 0, back: 0 },
    trackStyle: 'single',
    trackColor: '9003',
    blackHousing: false,
    controllerToFirstLightFt: 0,
    gaps: [],
  });
  // Andrew W shape — all-corners, parapet, 600W-forcing.
  record({
    footageBySide: { front: 0, left: 0, right: 0, back: 0 },
    cornersBySide: { front: 350, left: 0, right: 0, back: 0 },
    trackStyle: 'parapet',
    trackColor: '9004',
    blackHousing: false,
    controllerToFirstLightFt: 0,
    gaps: [],
  });
  for (const lights of TRANSFORMER_SWEEP_LIGHTS) {
    record({
      footageBySide: { front: lights / 1.5, left: 0, right: 0, back: 0 },
      cornersBySide: { front: 0, left: 0, right: 0, back: 0 },
      trackStyle: 'single',
      trackColor: '9003',
      blackHousing: false,
      controllerToFirstLightFt: 0,
      gaps: [],
    });
  }

  return skuCosts;
}

describe('ASCEND_CATALOG — lock-in against the BOM engine', () => {
  it('has no duplicate SKUs', () => {
    const skus = ASCEND_CATALOG.map((c) => c.sku);
    expect(new Set(skus).size).toBe(skus.length);
  });

  it('every SKU the BOM engine can emit exists in ASCEND_CATALOG with the SAME fallback cost', () => {
    const emitted = collectAllEmittedSkus();
    expect(emitted.size).toBeGreaterThan(0); // sanity — the sweep actually produced lines

    const catalogBySku = new Map(ASCEND_CATALOG.map((c) => [c.sku, c.wholesale_cost]));
    const missing: string[] = [];
    const mismatched: { sku: string; engine: number; catalog: number | null }[] = [];
    for (const [sku, engineCost] of emitted) {
      if (!catalogBySku.has(sku)) {
        missing.push(sku);
        continue;
      }
      const catalogCost = catalogBySku.get(sku)!;
      if (catalogCost === null || Math.abs(catalogCost - engineCost) > 1e-6) {
        mismatched.push({ sku, engine: engineCost, catalog: catalogCost });
      }
    }
    expect(missing).toEqual([]);
    expect(mismatched).toEqual([]);
  });
});

describe('costOverridesFromCatalog', () => {
  it('builds sku → wholesale_cost, skipping null/non-finite/<=0 rows', () => {
    const map = costOverridesFromCatalog([
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
    expect(costOverridesFromCatalog([]).size).toBe(0);
  });
});
