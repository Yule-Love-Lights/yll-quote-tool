// src/lib/inventory/bistroCatalog.ts
// Permanent Bistro Lighting (#117) — STATIC supplier catalog (Thunder Lighting
// Supply / Home Depot / Amazon). NO DB migration: inventory_catalog has no
// supplier/url columns (see migrations/FULL-SCHEMA.sql "10. inventory_catalog"),
// so this module — like ascendCatalog.ts for the permanent vertical — is the
// source of truth for supplier links + fallback costs. Feeds:
//  - the printable order sheet (bistro-bom/print) via buildBistroBom's
//    costOverrides hook (costOverridesFromBistroCatalog consults live
//    inventory_catalog rows by SKU, same pattern as ascendCatalog's
//    costOverridesFromCatalog — a future re-priced SKU in Settings flows in
//    without a code change);
//  - the /inventory/bistro reorder reference page (driver text + Order links).
//
// Costs mirror src/lib/permanentBistro/bom.ts's own built-in fallbacks EXACTLY
// (locked by bistroCatalog.test.ts) — unconfirmed Thunder/Amazon costs are $0
// on both sides; Home Depot + the eye screw are confirmed (Naldo 2026-07-11).

import type { CatalogItem } from './catalog';

export type BistroSupplier = 'thunder' | 'home-depot' | 'amazon';

export type BistroCatalogItem = {
  sku: string;
  name: string;
  supplier: BistroSupplier;
  url: string;
  /** Plain-English quantity driver, shown on the reorder reference page. */
  driver: string;
  /** 0 = unconfirmed (bom.ts flags this on the order sheet). */
  unitCost: number;
};

const THUNDER_URL = 'https://thunderlightingsupply.com/landscape-lighting/bistro-landscape-lighting/';
const HD_POST_URL =
  'https://www.homedepot.com/p/6-in-x-6-in-x-12-ft-2-Pressure-Treated-Ground-Contact-Southern-Pine-Timber-Wood-Post-6330254/100010238';
const HD_CONCRETE_URL = 'https://www.homedepot.com/p/SAKRETE-60-lb-Gray-Concrete-Mix-65200940/100321247';
const AMAZON_TIMER_URL = 'https://www.amazon.com/dp/B0F5M2S8VJ';

export const BISTRO_CATALOG: BistroCatalogItem[] = [
  { sku: '80324', name: 'E26 Bistro Cord 330ft, 24in spacing', supplier: 'thunder', url: THUNDER_URL, driver: '330 ft section', unitCost: 0 },
  { sku: '80011', name: 'Double Filament Bulb Warm White 120V', supplier: 'thunder', url: THUNDER_URL, driver: '1 per 24 in run (+6% waste)', unitCost: 0 },
  { sku: '80002', name: '3/32in Pro Guide Wire', supplier: 'thunder', url: THUNDER_URL, driver: '250 ft spool', unitCost: 0 },
  { sku: '93571', name: '3.75in L Eye Screw', supplier: 'thunder', url: THUNDER_URL, driver: '2 per strand', unitCost: 0.99 },
  { sku: '80005', name: 'Quick Link', supplier: 'thunder', url: THUNDER_URL, driver: '2 per strand', unitCost: 0 },
  { sku: '80004', name: 'Looping Gripper 3/32', supplier: 'thunder', url: THUNDER_URL, driver: '2 per strand', unitCost: 0 },
  { sku: '80308', name: 'Slide Plug SPT2 Black Male', supplier: 'thunder', url: THUNDER_URL, driver: '1 per strand', unitCost: 0 },
  { sku: '80307', name: 'Slide Plug SPT2 Black Female', supplier: 'thunder', url: THUNDER_URL, driver: '1 per strand', unitCost: 0 },
  { sku: '80305', name: 'SPT-2 Zip Wire 500ft Black', supplier: 'thunder', url: THUNDER_URL, driver: 'as needed (power feed to the outlet)', unitCost: 0 },
  { sku: '100010238', name: '6x6x12ft Pressure-Treated Post', supplier: 'home-depot', url: HD_POST_URL, driver: '1 per pole', unitCost: 56 },
  { sku: '100321247', name: 'SAKRETE 60 lb Gray Concrete Mix', supplier: 'home-depot', url: HD_CONCRETE_URL, driver: '1 per pole', unitCost: 6 },
  { sku: 'B0F5M2S8VJ', name: 'Tapo P430M Smart Outdoor Plug (timer)', supplier: 'amazon', url: AMAZON_TIMER_URL, driver: '1 per job', unitCost: 24 },
];

/**
 * SKU → wholesale_cost, for feeding buildBistroBom's costOverrides hook.
 * Skips any row whose wholesale_cost is null, non-finite, or <= 0 (a catalog
 * row with no usable price falls back to the engine's own baked-in cost).
 * Mirrors ascendCatalog.ts's costOverridesFromCatalog.
 */
export function costOverridesFromBistroCatalog(
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
