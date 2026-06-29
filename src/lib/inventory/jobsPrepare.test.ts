// Inventory safety (ledger #93): prepareJobMaterials must NOT decrement real
// on-hand for a TEST job, while still winning the claim + advancing the stage.
// A real job with the same materials DOES deduct — proving the gate is what makes
// the difference. The supabase client + the heavy deps are mocked; getJobWorkOrder
// runs for real so the is_test derive (via the quote join) is exercised end-to-end.

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
vi.mock('./bindings', () => ({ getInventoryBindings: vi.fn(async () => ({ bindings: [] })) }));
vi.mock('./catalog', () => ({ listCatalog: vi.fn(async () => []) }));
vi.mock('./onHand', () => ({ listOnHand: vi.fn(async () => []), upsertOnHand }));
// buildMaterialsView returns one tracked, deductible SKU regardless of inputs —
// so a real job WOULD deduct, and only the is_test gate stops it.
vi.mock('./materialsProjection', () => ({
  projectMaterials: vi.fn(() => []),
  buildMaterialsView: vi.fn(() => ({ materials: [{ sku: 'SKU-A', qty: 2, onHand: 10 }] })),
}));

import { prepareJobMaterials } from './jobs';

// A db fake whose chains all terminate in .maybeSingle(): the atomic claim
// (jobs UPDATE → select('id')), the stock_decremented_at read, the design read,
// and the quote read (which carries is_test).
function makeDb({ claimWins = true }: { claimWins?: boolean } = {}) {
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
            return { data: claimWins ? { id: jobRow?.id ?? 'j1' } : null, error: null };
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
  quoteRow = { customer_name: 'Test Customer', customer_address: '1 Test St', is_test: false };
});

describe('prepareJobMaterials — Test Quote stock safety (#93)', () => {
  it('decrements real on-hand for a NON-test job (the baseline)', async () => {
    quoteRow = { ...quoteRow, is_test: false };
    const res = await prepareJobMaterials('j1');
    expect(res).toEqual({
      ok: true,
      alreadyDone: false,
      deductions: [{ sku: 'SKU-A', before: 10, deducted: 2, after: 8 }],
    });
    expect(upsertOnHand).toHaveBeenCalledWith({ sku: 'SKU-A', on_hand_qty: 8 });
  });

  it('does NOT decrement on-hand for a TEST job, but still marks it prepped', async () => {
    quoteRow = { ...quoteRow, is_test: true };
    const res = await prepareJobMaterials('j1');
    // Won the claim (advanced + prepped) but zero stock movement.
    expect(res).toEqual({ ok: true, alreadyDone: false, deductions: [] });
    expect(upsertOnHand).not.toHaveBeenCalled();
  });

  it('reports alreadyDone (no deduction) when the claim is already taken', async () => {
    currentDb = makeDb({ claimWins: false });
    const res = await prepareJobMaterials('j1');
    expect(res).toEqual({ ok: true, alreadyDone: true });
    expect(upsertOnHand).not.toHaveBeenCalled();
  });
});
