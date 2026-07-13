// WA-A8 (WT-27): a bistro job's pooled Thunder PO lines must resolve their REAL
// BISTRO_CATALOG names, not "(not in catalog)". Bistro SKUs have no
// inventory_catalog DB rows (listCatalog() never returns them), so
// buildSupplierPurchaseOrder must backfill from the static BISTRO_CATALOG —
// mirrors the fix already in jobs.ts's getJobWorkOrder. Uses the REAL
// bistroBomFromQuote (unmocked, pure) so the SKUs are genuine.

import { describe, it, expect, beforeEach, vi } from 'vitest';

let currentDb: unknown = null;

vi.mock('../supabase', () => ({ getSupabaseServiceClient: () => currentDb }));
vi.mock('./bindings', () => ({ getInventoryBindings: vi.fn(async () => ({ bindings: {}, clipRules: {} })) }));
// No bistro SKUs in the DB catalog — proves the fallback isn't accidentally
// covered by a coincidental DB row.
vi.mock('./catalog', () => ({ listCatalog: vi.fn(async () => [{ sku: 'SKU-A', name: 'Holiday Widget' }]) }));
vi.mock('./onHand', () => ({ listOnHand: vi.fn(async () => []) }));
vi.mock('./orders', () => ({ sumOpenOnOrder: vi.fn(async () => new Map()) }));

import { buildSupplierPurchaseOrder } from './purchaseOrder';

const BISTRO_INPUTS = {
  permanentBistro: {
    bistro: [{ footage: 40 }],
    poles: 0,
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
              data: [{ quote_id: 'B', status: 'to_schedule', stock_decremented_at: null }],
              error: null,
            });
          }
          if (table === 'quotes') {
            return resolve({
              data: [
                {
                  id: 'B',
                  is_test: false,
                  approval_snapshot: null,
                  service_type: 'permanent_bistro',
                  inputs: BISTRO_INPUTS,
                },
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

describe('buildSupplierPurchaseOrder — bistro PO lines resolve real catalog names (WA-A8)', () => {
  it('names a pooled bistro SKU from BISTRO_CATALOG instead of "(not in catalog)"', async () => {
    const po = await buildSupplierPurchaseOrder();
    expect(po.jobCount).toBe(1);
    const bySku = new Map(po.lines.map((l) => [l.sku, l]));

    // 80324 = the Thunder bistro cord — a real pooled Thunder line for this job.
    const cord = bySku.get('80324');
    expect(cord).toBeTruthy();
    expect(cord!.name).toBe('E26 Bistro Cord 330ft, 24in spacing');
    expect(cord!.name).not.toBe('(not in catalog)');

    // No line should ever fall through to the fallback for a real bistro SKU.
    for (const l of po.lines) expect(l.name).not.toBe('(not in catalog)');
  });
});
