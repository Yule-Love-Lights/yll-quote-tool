// src/lib/inventory/ascendCatalog.ts
// P8 PR-2 — the ASCEND by Dauer APL catalog seed, in the ParsedCatalogItem shape
// upsertCatalogItems consumes. Source of truth: docs/permanent/BOM-DATA.md
// (Wave-0, Naldo 2026-07-03). Re-seed any time via
// upsertCatalogItems(ASCEND_CATALOG) — that upsert writes ONLY vendor columns
// (see catalog.ts toCatalogUpsertRow), so it never clobbers an operator's
// yll_category/locked overrides.
//
// Costs: for every SKU the permanent BOM engine (bom.ts) actually emits, the
// cost here is that engine's own built-in fallback (its `C` map) at FULL
// precision — those numbers are the golden-tested source (bom.test.ts pins
// them against the supplier estimator sheets). For SKUs the engine never
// emits (the demo kit, remote supply, standalone hub/adapter, the 50'
// extension-with-booster, the powder-coat book, the double-track colors, the
// wire end cap), the cost is BOM-DATA.md's own wholesale figure. See
// ascendCatalog.test.ts for the lock-in that keeps this file honest against
// the engine as either side changes.

import type { ParsedCatalogItem } from './parseThunderCsv';
import type { CatalogItem } from './catalog';

const CATEGORY = 'Permanent (ASCEND)';

function row(over: Partial<ParsedCatalogItem> & Pick<ParsedCatalogItem, 'sku' | 'name' | 'wholesale_cost'>): ParsedCatalogItem {
  return {
    category: CATEGORY,
    color: null,
    size: null,
    needs_adapter: false,
    bag_ct: null,
    case_ct: null,
    ...over,
  };
}

export const ASCEND_CATALOG: ParsedCatalogItem[] = [
  row({ sku: 'APL11000', name: 'ASCEND DEMO KIT WITH CASE', wholesale_cost: 485.10 }),

  // ── Transformers ────────────────────────────────────────────────────────
  row({ sku: 'APL11075-R', name: '75W MEANWELL REMOTE POWER SUPPLY 12V DC', wholesale_cost: 88.50 }),
  row({ sku: 'APL11110-350', name: '12V 350W POWER SUPPLY (waterproof box)', wholesale_cost: 251.9410488 }),
  row({ sku: 'APL11110-600', name: '12V 600W POWER SUPPLY (waterproof box)', wholesale_cost: 342.8476128 }),
  row({
    sku: 'APL11111-350-KIT',
    name: '350W CONTROL BOX + POWER SUPPLY + WIFI HUB + SIGNAL BOOSTER + FEMALE ADAPTER',
    wholesale_cost: 345.4449432,
  }),
  row({
    sku: 'APL11111-600-KIT',
    name: '600W CONTROL BOX + POWER SUPPLY + WIFI HUB + SIGNAL BOOSTER + FEMALE ADAPTER',
    wholesale_cost: 433.7541768,
  }),

  // ── Light sets (8" OC → ceil(ft*1.5) pucks) ─────────────────────────────
  row({ sku: 'APL11012-1', name: 'RGBW 3000K 12V LED (SINGLE)', wholesale_cost: 3.8471736 }),
  row({ sku: 'APL11012-5', name: 'RGBW 3000K 12V LED (SET OF 5)', wholesale_cost: 15.5156316 }),
  row({ sku: 'APL11012-1-BLK', name: 'RGBW single, BLACK housing', color: 'Black', wholesale_cost: 3.8471736 }),
  row({ sku: 'APL11012-5-BLK', name: 'RGBW set of 5, BLACK housing', color: 'Black', wholesale_cost: 15.5156316 }),

  // ── Accessories ──────────────────────────────────────────────────────────
  row({ sku: 'APL11120', name: 'WIFI BRIDGE (HUB) CONTROLLER', wholesale_cost: 83.11 }),
  row({ sku: 'APL11121', name: 'SIGNAL BOOSTER', wholesale_cost: 12.6644268 }),
  row({ sku: 'APL11122', name: 'SPLITTER 12V', wholesale_cost: 6.6495564 }),
  row({ sku: 'APL11123', name: 'POWER T-INJECTOR 12V', wholesale_cost: 5.8488756 }),
  // #145 CONFIRMED (Naldo 2026-07-10, from Ascend) — sold by the 500 ft roll.
  // 16/2 feeds up to 2 injection points per run; 14/2 up to 3. bom.ts picks
  // the type by fewest runs for the whole job (tie → cheaper 16/2).
  row({ sku: 'IW162500', name: 'POWER INJECTION WIRE 16/2 (500 FT ROLL)', wholesale_cost: 124.99 }),
  row({ sku: 'IW142500L', name: 'POWER INJECTION WIRE 14/2 (500 FT ROLL)', wholesale_cost: 179.99 }),
  row({ sku: 'APL11126', name: 'FEMALE ADAPTER (wire into hub)', wholesale_cost: 2.9196 }),
  row({ sku: 'APL11130', name: "50' EXTENSION WITH SIGNAL BOOSTER", size: "50'", wholesale_cost: 33.7653 }),
  row({ sku: 'APL11200', name: 'POWDER COAT COLOR BOOK', wholesale_cost: 31.92 }),
  row({ sku: 'APL11330', name: 'WIRE END CAP (BAG OF 25)', bag_ct: 25, wholesale_cost: 3.1539 }),

  // ── Tracks (40" sections → ceil(ft/(40/12)) + 6% waste) ─────────────────
  // Single track — 4 stock colors; the engine emits these (bom.ts trackSku()).
  row({ sku: 'APL11210-9003', name: '40" SINGLE TRACK white', color: '9003', size: '40"', wholesale_cost: 7.3330644 }),
  row({ sku: 'APL11210-9004', name: '40" SINGLE TRACK black', color: '9004', size: '40"', wholesale_cost: 7.3330644 }),
  row({ sku: 'APL11210-9012', name: '40" SINGLE TRACK cream', color: '9012', size: '40"', wholesale_cost: 7.3330644 }),
  row({ sku: 'APL11210-8019', name: '40" SINGLE TRACK dark-brown', color: '8019', size: '40"', wholesale_cost: 7.3330644 }),

  // Double (2PC) track — the engine never builds a double-track BOM line today;
  // seeded from BOM-DATA.md for catalog completeness (a future variant / manual
  // order lookup). Bronze/lt-grey are priced 7.95, the rest 7.9482.
  row({ sku: 'APL11220-9003', name: '40" DOUBLE (2PC) TRACK white', color: '9003', size: '40"', wholesale_cost: 7.9482 }),
  row({ sku: 'APL11220-9004', name: '40" DOUBLE (2PC) TRACK black', color: '9004', size: '40"', wholesale_cost: 7.9482 }),
  row({ sku: 'APL11220-9012', name: '40" DOUBLE (2PC) TRACK cream', color: '9012', size: '40"', wholesale_cost: 7.9482 }),
  row({ sku: 'APL11220-8019', name: '40" DOUBLE (2PC) TRACK brown', color: '8019', size: '40"', wholesale_cost: 7.9482 }),
  row({ sku: 'APL11220-8022', name: '40" DOUBLE (2PC) TRACK bronze', color: '8022', size: '40"', wholesale_cost: 7.95 }),
  row({ sku: 'APL11220-7045', name: '40" DOUBLE (2PC) TRACK lt-grey', color: '7045', size: '40"', wholesale_cost: 7.95 }),

  // Parapet-90 track — stocked only white/black (BOM-DATA note); the engine
  // emits the 90° SKU for ANY track color when trackStyle is 'parapet' (a
  // non-stock color flags 'parapet-track-only-stocked-white-or-black' on the
  // BOM rather than failing), so all 4 stock TrackColor variants are seeded
  // here at the same fallback cost the engine uses regardless of color.
  row({ sku: 'APL11230-90-9003', name: '40" PARAPET TRACK 90° white', color: '9003', size: '40"', wholesale_cost: 8.3778552 }),
  row({ sku: 'APL11230-90-9004', name: '40" PARAPET TRACK 90° black', color: '9004', size: '40"', wholesale_cost: 8.3778552 }),
  row({ sku: 'APL11230-90-9012', name: '40" PARAPET TRACK 90° cream (non-stock)', color: '9012', size: '40"', wholesale_cost: 8.3778552 }),
  row({ sku: 'APL11230-90-8019', name: '40" PARAPET TRACK 90° dark-brown (non-stock)', color: '8019', size: '40"', wholesale_cost: 8.3778552 }),

  // ── Extensions ────────────────────────────────────────────────────────────
  row({ sku: 'APL11312-3', name: "3' EXTENSION 12V M-F", size: "3'", wholesale_cost: 2.9439666 }),
  row({ sku: 'APL11312-5', name: "5' EXTENSION", size: "5'", wholesale_cost: 3.4565976 }),
  row({ sku: 'APL11312-10', name: "10' EXTENSION", size: "10'", wholesale_cost: 4.6087968 }),
  row({ sku: 'APL11312-25', name: "25' EXTENSION", size: "25'", wholesale_cost: 10.7115468 }),
  row({ sku: 'APL11312-50', name: "50' EXTENSION", size: "50'", wholesale_cost: 21.1008684 }),
];

/**
 * SKU → wholesale_cost, for feeding buildPermanentBom's costOverrides hook.
 * Skips any row whose wholesale_cost is null, non-finite, or <= 0 (a catalog
 * row with no usable price falls back to the engine's own baked-in cost).
 */
export function costOverridesFromCatalog(
  items: Pick<CatalogItem, 'sku' | 'wholesale_cost'>[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) {
    const cost = item.wholesale_cost;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost > 0) {
      map.set(item.sku, cost);
    }
  }
  return map;
}
