// P8 PR-2: getJobWorkOrder must build a PERMANENT job's materials from the
// Ascend/Dauer BOM engine (permanentBomFromQuote) rather than the holiday
// scene projection — a permanent quote's design scene (if any) must NOT feed
// holiday materials. Holiday/event jobs keep today's scene-projection path
// untouched (positive `=== 'permanent'` gate, never a negative one).

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

// A db fake whose chains all terminate in .maybeSingle(): the stock_decremented_at
// read, the design read, and the quote read (now carrying service_type + inputs).
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

const PERMANENT_INPUTS = {
  permanent: {
    frontFootage: 60,
    leftFootage: 0,
    rightFootage: 0,
    backFootage: 40,
    gaps: [],
    controllerToFirstLightFt: 0,
    frontCorners: 2,
    leftCorners: 0,
    rightCorners: 0,
    backCorners: 0,
    trackStyle: 'single' as const,
    trackColor: '9003' as const,
    blackHousing: false,
    maintenanceAddOn: false,
  },
};

describe('getJobWorkOrder — permanent jobs join the BOM (P8 PR-2)', () => {
  it('builds materials from permanentBomFromQuote and skips the scene projection entirely', async () => {
    quoteRow = {
      customer_name: 'Perm Customer',
      customer_address: '1 Perm St',
      is_test: false,
      approval_snapshot: null,
      service_type: 'permanent',
      inputs: PERMANENT_INPUTS,
    };
    const wo = await getJobWorkOrder('j1');
    expect(wo).not.toBeNull();
    expect(projectMaterials).not.toHaveBeenCalled();
    // The BOM for 100ft (60+40) single-white, 2 front corners: track + lights +
    // a transformer KIT — real SKUs from the ASCEND catalog, no null skus.
    const skus = wo!.materials.materials.map((m) => m.sku);
    expect(skus).toContain('APL11012-5');
    expect(skus).toContain('APL11210-9003');
    expect(skus).toContain('APL11111-350-KIT');
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

  it('event jobs (not permanent) also keep the scene-projection path', async () => {
    quoteRow = {
      customer_name: 'Event Customer',
      customer_address: '1 Event St',
      is_test: false,
      approval_snapshot: null,
      service_type: 'event',
      inputs: null,
    };
    const wo = await getJobWorkOrder('j1');
    expect(wo).not.toBeNull();
    expect(projectMaterials).toHaveBeenCalledTimes(1);
  });
});
