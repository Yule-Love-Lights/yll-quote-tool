// Inventory safety (ledger #93): buildSupplierPurchaseOrder must EXCLUDE test
// jobs, so a test job's material needs never reach the real supplier order. Each
// active job projects the same SKU; with one job dropped as a test, the PO halves.
// The supabase client + heavy deps are mocked (isActiveFulfillment runs for real).

import { describe, it, expect, beforeEach, vi } from 'vitest';

// #110 W7-009: shared so the bindings mock and the pass-through assertion agree.
const { CLIP_RULES } = vi.hoisted(() => ({ CLIP_RULES: { gutterline: { sku: 'CLIP-1' } } }));

let currentDb: unknown = null;
let testQuoteIds: string[] = ['T'];

vi.mock('../supabase', () => ({ getSupabaseServiceClient: () => currentDb }));
vi.mock('./bindings', () => ({ getInventoryBindings: vi.fn(async () => ({ bindings: [], clipRules: CLIP_RULES })) }));
vi.mock('./catalog', () => ({ listCatalog: vi.fn(async () => [{ sku: 'SKU-A', name: 'Widget' }]) }));
vi.mock('./onHand', () => ({ listOnHand: vi.fn(async () => []) }));
// Every job projects 5 of SKU-A, so the PO size is a direct count of INCLUDED jobs.
vi.mock('./materialsProjection', () => ({
  projectMaterials: vi.fn(() => []),
  aggregateMaterials: vi.fn(() => [{ sku: 'SKU-A', qty: 5 }]),
}));

import { buildSupplierPurchaseOrder } from './purchaseOrder';
import { projectMaterials } from './materialsProjection';

// Thenable db fake. Two active jobs (quotes R + T); the is_test lookup returns
// `testQuoteIds`; designs resolve a (trivial) scene per quote.
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
                { quote_id: 'R', status: 'to_schedule', stock_decremented_at: null },
                { quote_id: 'T', status: 'to_schedule', stock_decremented_at: null },
              ],
              error: null,
            });
          }
          if (table === 'quotes') {
            // New #92 query: all active quotes with is_test + approval_snapshot;
            // test-ness is derived in JS from is_test (not an .eq filter).
            return resolve({
              data: ['R', 'T'].map((id) => ({ id, is_test: testQuoteIds.includes(id), approval_snapshot: null })),
              error: null,
            });
          }
          if (table === 'designs') {
            return resolve({
              data: [
                { quote_id: 'R', scene: {} },
                { quote_id: 'T', scene: {} },
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
  testQuoteIds = ['T'];
});

describe('buildSupplierPurchaseOrder — Test Quote exclusion (#93)', () => {
  it('drops the test job: only the real job (5 of SKU-A) reaches the PO', async () => {
    const po = await buildSupplierPurchaseOrder();
    expect(po.jobCount).toBe(1); // T excluded, R kept
    expect(po.lines).toEqual([{ sku: 'SKU-A', name: 'Widget', needed: 5, onHand: 0, order: 5 }]);
  });

  it('keeps both jobs (order 10) when neither quote is a test quote', async () => {
    testQuoteIds = [];
    const po = await buildSupplierPurchaseOrder();
    expect(po.jobCount).toBe(2);
    expect(po.lines).toEqual([{ sku: 'SKU-A', name: 'Widget', needed: 10, onHand: 0, order: 10 }]);
  });

  it('passes clipRules through to projectMaterials (#110 W7-009 — clips must reach the PO, not be dropped as {})', async () => {
    await buildSupplierPurchaseOrder();
    // 3rd positional arg of projectMaterials(scene, bindings, clipRules, colorChoice).
    expect(vi.mocked(projectMaterials).mock.calls[0][2]).toEqual(CLIP_RULES);
  });
});
