// #117: getJobWorkOrder must build a PERMANENT-BISTRO job's materials from the
// bistro BOM engine (bistroBomFromQuote) rather than the holiday scene
// projection — a bistro quote's design scene (if any) must NOT feed holiday
// materials. Holiday/event/permanent jobs keep their existing paths untouched
// (positive `=== 'permanent_bistro'` gate, never a negative one). Mirrors
// jobsWorkOrderPermanent.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';

let currentDb: unknown = null;
let jobRow: Record<string, unknown> | null = null;
let quoteRow: Record<string, unknown> | null = null;

vi.mock('../supabase', () => ({ getSupabaseServiceClient: () => currentDb }));
vi.mock('../jobs', () => ({
  getJob: vi.fn(async () => jobRow),
  listJobs: vi.fn(async () => []),
}));
vi.mock('./bindings', () => ({ getInventoryBindings: vi.fn(async () => ({ bindings: {}, clipRules: {} })) }));
vi.mock('./catalog', () => ({
  listCatalog: vi.fn(async () => []),
  catalogCostOverrides: vi.fn(async () => new Map()),
}));
vi.mock('./onHand', () => ({ listOnHand: vi.fn(async () => []), upsertOnHand: vi.fn(async () => {}) }));

const { projectMaterials } = vi.hoisted(() => ({ projectMaterials: vi.fn(() => []) }));
vi.mock('./materialsProjection', () => ({
  projectMaterials,
  buildMaterialsView: vi.fn((lines: { sku: string | null; qty: number }[]) => ({
    materials: lines
      .filter((l) => l.sku)
      .map((l) => ({ sku: l.sku, name: '(not in catalog)', qty: l.qty, onHand: null, short: false })),
    unbound: [],
    totalLines: lines.length,
  })),
}));

import { getJobWorkOrder } from './jobs';

function makeDb() {
  return {
    from(table: string) {
      const state = { table, cols: '' };
      const b = {
        select(cols?: string) {
          state.cols = cols ?? '';
          return b;
        },
        eq() {
          return b;
        },
        async maybeSingle() {
          if (table === 'jobs') return { data: { stock_decremented_at: null }, error: null };
          if (table === 'designs') return { data: { scene: { yardsticks: [], items: [{ id: 'x', kind: 'strand' }] } }, error: null };
          if (table === 'quotes') return { data: quoteRow, error: null };
          return { data: null, error: null };
        },
      };
      return b;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  projectMaterials.mockClear();
  currentDb = makeDb();
  jobRow = {
    id: 'j1',
    job_number: 1000,
    quote_id: 'q1',
    design_id: 'd1',
    fulfillment_stage: 'to_be_prepared',
    status: 'to_schedule',
    install_date: null,
    line_items: [],
  };
});

const BISTRO_INPUTS = {
  permanentBistro: {
    bistro: [{ footage: 40 }, { footage: 35 }, { footage: 25 }],
    poles: 2,
  },
};

describe('getJobWorkOrder — permanent-bistro jobs join the bistro BOM (#117)', () => {
  it('builds materials from bistroBomFromQuote and skips the scene projection entirely', async () => {
    quoteRow = {
      customer_name: 'Bistro Customer',
      customer_address: '1 Bistro St',
      is_test: false,
      approval_snapshot: null,
      service_type: 'permanent_bistro',
      inputs: BISTRO_INPUTS,
    };
    const wo = await getJobWorkOrder('j1');
    expect(wo).not.toBeNull();
    expect(projectMaterials).not.toHaveBeenCalled();
    const skus = wo!.materials.materials.map((m) => m.sku);
    // Real Thunder/Home Depot/Amazon SKUs — no null skus.
    expect(skus).toContain('80324'); // cord
    expect(skus).toContain('93571'); // eye screw
    expect(skus).toContain('100010238'); // post
    expect(skus).toContain('B0F5M2S8VJ'); // timer
    // The as-needed zip-wire row has nothing to pick/prep — excluded from the
    // work order's materials list (still prints on the order sheet).
    expect(skus).not.toContain('80305');
    expect(wo!.materials.unbound).toEqual([]); // every BOM line carries a real SKU
    for (const m of wo!.materials.materials) expect(m.qty).toBeGreaterThan(0);
  });

  it('holiday jobs keep the scene-projection path untouched (positive gate, not negative)', async () => {
    quoteRow = {
      customer_name: 'Holiday Customer',
      customer_address: '1 Holiday St',
      is_test: false,
      approval_snapshot: null,
      service_type: 'holiday',
      inputs: null,
    };
    const wo = await getJobWorkOrder('j1');
    expect(wo).not.toBeNull();
    expect(projectMaterials).toHaveBeenCalledTimes(1);
  });

  it('an empty bistro job (no footage, no poles) yields no materials, no crash', async () => {
    quoteRow = {
      customer_name: 'Empty Bistro',
      customer_address: '1 Empty St',
      is_test: false,
      approval_snapshot: null,
      service_type: 'permanent_bistro',
      inputs: { permanentBistro: {} },
    };
    const wo = await getJobWorkOrder('j1');
    expect(wo).not.toBeNull();
    expect(projectMaterials).not.toHaveBeenCalled();
    expect(wo!.materials.materials).toEqual([]);
  });
});
