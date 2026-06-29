// Inventory safety (ledger #93): buildSupplierPurchaseOrder must EXCLUDE test
// jobs, so a test job's material needs never reach the real supplier order. Each
// active job projects the same SKU; with one job dropped as a test, the PO halves.
// The supabase client + heavy deps are mocked (isActiveFulfillment runs for real).

import { describe, it, expect, beforeEach, vi } from 'vitest';

let currentDb: unknown = null;
let testQuoteIds: string[] = ['T'];

vi.mock('../supabase', () => ({ getSupabaseServiceClient: () => currentDb }));
vi.mock('./bindings', () => ({ getInventoryBindings: vi.fn(async () => ({ bindings: [] })) }));
vi.mock('./catalog', () => ({ listCatalog: vi.fn(async () => [{ sku: 'SKU-A', name: 'Widget' }]) }));
vi.mock('./onHand', () => ({ listOnHand: vi.fn(async () => []) }));
// Every job projects 5 of SKU-A, so the PO size is a direct count of INCLUDED jobs.
vi.mock('./materialsProjection', () => ({
  projectMaterials: vi.fn(() => []),
  aggregateMaterials: vi.fn(() => [{ sku: 'SKU-A', qty: 5 }]),
}));

import { buildSupplierPurchaseOrder } from './purchaseOrder';

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
            return resolve({ data: testQuoteIds.map((id) => ({ id })), error: null });
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
});
