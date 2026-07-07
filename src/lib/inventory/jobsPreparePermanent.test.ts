// P8 PR-2: prepareJobMaterials must deduct the permanent BOM's SKUs for a
// permanent job — this is a thin proof that the getJobWorkOrder permanent
// branch (jobsWorkOrderPermanent.test.ts) flows straight through the existing
// prep/claim/deduct pipeline with no extra wiring needed.

import { describe, it, expect, beforeEach, vi } from 'vitest';

let currentDb: unknown = null;
let jobRow: Record<string, unknown> | null = null;
let quoteRow: Record<string, unknown> | null = null;
const { upsertOnHand } = vi.hoisted(() => ({ upsertOnHand: vi.fn(async () => {}) }));

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
// APL11012-5 (a real permanent BOM SKU) tracked on-hand at 100 — enough to
// prove the deduction reads from the BOM-derived materials, not the empty scene.
vi.mock('./onHand', () => ({
  listOnHand: vi.fn(async () => [{ sku: 'APL11012-5', on_hand_qty: 100 }]),
  upsertOnHand,
}));
vi.mock('./materialsProjection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./materialsProjection')>();
  return { ...actual, projectMaterials: vi.fn(() => []) };
});

import { prepareJobMaterials } from './jobs';

function makeDb() {
  return {
    from(table: string) {
      const state = { table, op: 'select' as 'select' | 'update', cols: '' };
      const b = {
        update() {
          state.op = 'update';
          return b;
        },
        select(cols?: string) {
          state.cols = cols ?? '';
          return b;
        },
        eq() {
          return b;
        },
        is() {
          return b;
        },
        async maybeSingle() {
          if (table === 'jobs' && state.op === 'update') {
            return { data: { id: jobRow?.id ?? 'j1' }, error: null };
          }
          if (table === 'jobs' && state.cols.includes('stock_decremented_at')) {
            return { data: { stock_decremented_at: null }, error: null };
          }
          if (table === 'designs') return { data: null, error: null };
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
  currentDb = makeDb();
  jobRow = {
    id: 'j1',
    job_number: 1000,
    quote_id: 'q1',
    design_id: null,
    fulfillment_stage: 'to_be_prepared',
    status: 'to_schedule',
    install_date: null,
    line_items: [],
  };
  quoteRow = {
    customer_name: 'Perm Customer',
    customer_address: '1 Perm St',
    is_test: false,
    approval_snapshot: null,
    service_type: 'permanent',
    inputs: {
      permanent: {
        frontFootage: 40, // 60 pucks → 12 sets of 5 (APL11012-5 qty 12)
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
    },
  };
});

describe('prepareJobMaterials — permanent job deducts BOM SKUs (P8 PR-2)', () => {
  it('decrements on-hand for a tracked permanent BOM SKU', async () => {
    const res = await prepareJobMaterials('j1');
    expect(res?.ok).toBe(true);
    if (!res?.ok || res.alreadyDone) throw new Error('expected a fresh prep');
    const apl5 = res.deductions.find((d) => d.sku === 'APL11012-5');
    expect(apl5).toBeTruthy();
    expect(apl5!.before).toBe(100);
    expect(apl5!.deducted).toBeGreaterThan(0);
    expect(upsertOnHand).toHaveBeenCalledWith({ sku: 'APL11012-5', on_hand_qty: apl5!.after });
  });
});
