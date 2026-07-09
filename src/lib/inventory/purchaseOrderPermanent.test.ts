// P8 PR-2: buildSupplierPurchaseOrder must accumulate need from BOTH a
// permanent active job (via permanentBomFromQuote) and a holiday active job
// (via the scene projection) — ASCEND SKUs ride the same Thunder PO email as
// holiday SKUs (Naldo: one email, all SKUs). On-hand + on-order subtraction
// applies uniformly to the combined SKU set.

import { describe, it, expect, beforeEach, vi } from 'vitest';

let currentDb: unknown = null;

vi.mock('../supabase', () => ({ getSupabaseServiceClient: () => currentDb }));
vi.mock('./bindings', () => ({ getInventoryBindings: vi.fn(async () => ({ bindings: {}, clipRules: {} })) }));
vi.mock('./catalog', () => ({
  listCatalog: vi.fn(async () => [
    { sku: 'SKU-A', name: 'Holiday Widget' },
    { sku: 'APL11012-5', name: 'RGBW set of 5' },
    { sku: 'APL11210-9003', name: '40" single track white' },
  ]),
}));
vi.mock('./onHand', () => ({ listOnHand: vi.fn(async () => []) }));
vi.mock('./orders', () => ({ sumOpenOnOrder: vi.fn(async () => new Map()) }));
// The holiday job (quote H) always projects 5 of SKU-A; the permanent job's
// scene must NEVER be projected (its scene, if fetched, is a poisoned payload
// that would also yield SKU-A — proving the permanent branch skips it).
vi.mock('./materialsProjection', () => ({
  projectMaterials: vi.fn(() => []),
  aggregateMaterials: vi.fn(() => [{ sku: 'SKU-A', qty: 5 }]),
}));

import { buildSupplierPurchaseOrder } from './purchaseOrder';
import { aggregateMaterials } from './materialsProjection';

const PERMANENT_INPUTS = {
  permanent: {
    frontFootage: 40, // 60 pucks → 12 sets of 5 (APL11012-5 qty 12) + track
    leftFootage: 0,
    rightFootage: 0,
    backFootage: 0,
    gaps: [],
    controllerToFirstLightFt: 0,
    frontCorners: 0,
    leftCorners: 0,
    rightCorners: 0,
    backCorners: 0,
    trackStyle: 'single',
    trackColor: '9003',
    blackHousing: false,
    maintenanceAddOn: false,
  },
};

function makeDb() {
  return {
    from(table: string) {
      const b = {
        select: () => b,
        is: () => b,
        eq: () => b,
        in: () => b,
        then: (resolve: (v: unknown) => void) => {
          if (table === 'jobs') {
            return resolve({
              data: [
                { quote_id: 'H', status: 'to_schedule', stock_decremented_at: null },
                { quote_id: 'P', status: 'to_schedule', stock_decremented_at: null },
              ],
              error: null,
            });
          }
          if (table === 'quotes') {
            return resolve({
              data: [
                { id: 'H', is_test: false, approval_snapshot: null, service_type: 'holiday', inputs: null },
                { id: 'P', is_test: false, approval_snapshot: null, service_type: 'permanent', inputs: PERMANENT_INPUTS },
              ],
              error: null,
            });
          }
          if (table === 'designs') {
            // A poisoned scene for the permanent quote — if the permanent
            // branch ever fed this into projectMaterials, the mock above would
            // hand back another 5 of SKU-A, doubling the holiday count.
            return resolve({
              data: [
                { quote_id: 'H', scene: {} },
                { quote_id: 'P', scene: { poisoned: true } },
              ],
              error: null,
            });
          }
          return resolve({ data: [], error: null });
        },
      };
      return b;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentDb = makeDb();
});

describe('buildSupplierPurchaseOrder — permanent + holiday jobs together (P8 PR-2)', () => {
  it('accumulates BOM SKUs from the permanent job and projection SKUs from the holiday job', async () => {
    const po = await buildSupplierPurchaseOrder();
    expect(po.jobCount).toBe(2);
    const bySku = new Map(po.lines.map((l) => [l.sku, l]));

    // Holiday job: 5 of SKU-A (scene projection, untouched).
    expect(bySku.get('SKU-A')).toEqual({ sku: 'SKU-A', name: 'Holiday Widget', needed: 5, onHand: 0, onOrder: 0, order: 5 });

    // Permanent job: 40ft single-white track, no corners → 60 pucks = 12 sets
    // of 5, ordered w/6% waste (#144) → 13. Only asserting the lights line
    // here; bom.test.ts pins the exact formulas.
    const lights = bySku.get('APL11012-5');
    expect(lights).toBeTruthy();
    expect(lights!.needed).toBe(13);
    expect(lights!.order).toBe(13);

    const track = bySku.get('APL11210-9003');
    expect(track).toBeTruthy();
    expect(track!.needed).toBeGreaterThan(0);

    // The permanent quote's scene was never handed to projectMaterials/aggregateMaterials
    // for a SECOND time (only the holiday job's aggregateMaterials call counts).
    expect(vi.mocked(aggregateMaterials)).toHaveBeenCalledTimes(1);
  });
});
