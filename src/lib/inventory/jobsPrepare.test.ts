// Inventory safety (ledger #93): prepareJobMaterials must NOT decrement real
// on-hand for a TEST job, while still winning the claim + advancing the stage.
// A real job with the same materials DOES deduct — proving the gate is what makes
// the difference. The supabase client + the heavy deps are mocked; getJobWorkOrder
// runs for real so the is_test derive (via the quote join) is exercised end-to-end.

import { describe, it, expect, beforeEach, vi } from 'vitest';

let currentDb: unknown = null;
let jobRow: Record<string, unknown> | null = null;
let quoteRow: Record<string, unknown> | null = null;

// Row 329: adjustOnHandAtomic now returns {before,after,applied} (the ACTUAL
// applied delta, which can differ from the request if the real function's
// floor-at-0 clamp bites). By default this mock never clamps — the
// buildMaterialsView mock's onHand for SKU-A (10) always covers the intended
// deduction (qty 2), so applied === the requested delta exactly. The one test
// below that needs a clamp overrides this default via mockResolvedValueOnce;
// the clamp arithmetic itself is unit-tested directly in onHand.test.ts.
const { adjustOnHandAtomic } = vi.hoisted(() => ({
  adjustOnHandAtomic: vi.fn(async (_db: unknown, _sku: string, delta: number) => {
    const before = 10;
    const after = Math.max(0, before + delta);
    return { before, after, applied: after - before };
  }),
}));

vi.mock('../supabase', () => ({ getSupabaseServiceClient: () => currentDb }));
vi.mock('../jobs', () => ({
  getJob: vi.fn(async () => jobRow),
  listJobs: vi.fn(async () => []),
}));
vi.mock('./bindings', () => ({ getInventoryBindings: vi.fn(async () => ({ bindings: [] })) }));
vi.mock('./catalog', () => ({ listCatalog: vi.fn(async () => []) }));
vi.mock('./onHand', () => ({ listOnHand: vi.fn(async () => []), adjustOnHandAtomic }));
// buildMaterialsView returns one tracked, deductible SKU regardless of inputs —
// so a real job WOULD deduct, and only the is_test gate stops it.
vi.mock('./materialsProjection', () => ({
  projectMaterials: vi.fn(() => []),
  buildMaterialsView: vi.fn(() => ({ materials: [{ sku: 'SKU-A', qty: 2, onHand: 10 }] })),
}));

import { prepareJobMaterials } from './jobs';

// A db fake whose chains all terminate in .maybeSingle(): the atomic claim
// (jobs UPDATE → select('id')), the Row 329 snapshot-write UPDATE that follows
// it (also → select('id').maybeSingle(), same shape), the stock_decremented_at
// read, the design read, and the quote read (which carries is_test).
// `onJobsUpdate` fires for EVERY update to the jobs table, in call order — the
// Row 329 tests below use this to see both the claim payload (first call,
// carries stock_decremented_at) and the separate snapshot payload (second
// call, carries only stock_deductions) distinctly.
function makeDb({
  claimWins = true,
  claimErrorMsg,
  onClaim,
  onJobsUpdate,
}: {
  claimWins?: boolean;
  claimErrorMsg?: string;
  onClaim?: () => void;
  onJobsUpdate?: (payload: Record<string, unknown>) => void;
} = {}) {
  return {
    from(table: string) {
      // Distinguish the atomic CLAIM update from the Row 329 snapshot write
      // that follows it by PAYLOAD SHAPE (both end in .select('id').maybeSingle()
      // and so look identical structurally) — only the claim's payload carries
      // stock_decremented_at.
      const state = { table, op: 'select' as 'select' | 'update', cols: '', isClaim: false };
      const b = {
        update(payload: Record<string, unknown>) {
          state.op = 'update';
          state.isClaim = 'stock_decremented_at' in payload;
          if (table === 'jobs') {
            onClaim?.();
            onJobsUpdate?.(payload);
          }
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
          if (table === 'jobs' && state.op === 'update' && state.isClaim) {
            if (claimErrorMsg) return { data: null, error: { message: claimErrorMsg } };
            return { data: claimWins ? { id: jobRow?.id ?? 'j1' } : null, error: null };
          }
          if (table === 'jobs' && state.op === 'update') {
            // The Row 329 snapshot write — always "succeeds" here; its own
            // failure mode is covered by a dedicated test with its own fake.
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
    // The write is now an ATOMIC NEGATIVE delta (-deducted), not an absolute set,
    // so a concurrent receipt/decrement on the same SKU can't be clobbered.
    expect(adjustOnHandAtomic).toHaveBeenCalledWith(expect.anything(), 'SKU-A', -2);
  });

  it('does NOT decrement on-hand for a TEST job, but still marks it prepped', async () => {
    quoteRow = { ...quoteRow, is_test: true };
    const res = await prepareJobMaterials('j1');
    // Won the claim (advanced + prepped) but zero stock movement.
    expect(res).toEqual({ ok: true, alreadyDone: false, deductions: [] });
    expect(adjustOnHandAtomic).not.toHaveBeenCalled();
  });

  it('reports alreadyDone (no deduction) when the claim is already taken', async () => {
    currentDb = makeDb({ claimWins: false });
    const res = await prepareJobMaterials('j1');
    expect(res).toEqual({ ok: true, alreadyDone: true });
    expect(adjustOnHandAtomic).not.toHaveBeenCalled();
  });

  it('does NOT stamp a phantom claim when the materials read fails (#110 W7-008 — read before claim)', async () => {
    // getJob → null makes getJobWorkOrder return null, simulating a missing job
    // OR a transient post-claim read failure (its reads swallow errors to empty).
    jobRow = null;
    let claimAttempted = false;
    currentDb = makeDb({ onClaim: () => { claimAttempted = true; } });
    const res = await prepareJobMaterials('j1');
    // Returns retryable null WITHOUT ever claiming — so the job is never left
    // marked prepped with zero stock deducted (the old bug), and a retry works.
    expect(res).toBeNull();
    expect(claimAttempted).toBe(false);
    expect(adjustOnHandAtomic).not.toHaveBeenCalled();
  });
});

describe('prepareJobMaterials — Row 325/329 stock_deductions snapshot', () => {
  it('claims first WITHOUT stock_deductions, then persists the ACTUAL deductions in a SEPARATE follow-up write', async () => {
    // Row 329: the claim can no longer carry an accurate snapshot in the SAME
    // write, because the real (possibly clamped) amount isn't known until
    // AFTER the deduction loop runs, which can only run after the claim wins
    // (to avoid double-deducting on a race). Two 'jobs' updates are expected
    // now, in order: the claim (no stock_deductions field), then the snapshot.
    const jobsUpdates: Record<string, unknown>[] = [];
    currentDb = makeDb({ onJobsUpdate: (p) => jobsUpdates.push(p) });
    quoteRow = { ...quoteRow, is_test: false };
    const res = await prepareJobMaterials('j1');
    expect(res).toEqual({
      ok: true,
      alreadyDone: false,
      deductions: [{ sku: 'SKU-A', before: 10, deducted: 2, after: 8 }],
    });
    expect(jobsUpdates).toHaveLength(2);
    const [claimPayload, snapshotPayload] = jobsUpdates;
    expect(claimPayload.stock_decremented_at).toEqual(expect.any(String));
    expect(claimPayload.fulfillment_stage).toBe('ready_for_install');
    expect(claimPayload).not.toHaveProperty('stock_deductions');
    expect(snapshotPayload).toEqual({
      stock_deductions: [{ sku: 'SKU-A', before: 10, deducted: 2, after: 8 }],
    });
  });

  it('persists an EMPTY snapshot for a test job (never touches real on-hand, but the shape stays consistent)', async () => {
    const jobsUpdates: Record<string, unknown>[] = [];
    currentDb = makeDb({ onJobsUpdate: (p) => jobsUpdates.push(p) });
    quoteRow = { ...quoteRow, is_test: true };
    const res = await prepareJobMaterials('j1');
    expect(res).toEqual({ ok: true, alreadyDone: false, deductions: [] });
    expect(jobsUpdates[1]).toEqual({ stock_deductions: [] });
  });

  it('Row 329: reports the ACTUAL applied amount, not the intended one, when adjustOnHandAtomic clamps', async () => {
    // Only THIS test overrides the module-level mock to simulate a clamp:
    // the intended deduction asks for -2, but only -1 actually lands (a
    // concurrent prep/receipt already dropped on-hand to 1 before this SKU's
    // write ran) — mirrors onHand.ts's real Math.max(0, before + delta).
    adjustOnHandAtomic.mockResolvedValueOnce({ before: 1, after: 0, applied: -1 });
    const jobsUpdates: Record<string, unknown>[] = [];
    currentDb = makeDb({ onJobsUpdate: (p) => jobsUpdates.push(p) });
    quoteRow = { ...quoteRow, is_test: false };
    const res = await prepareJobMaterials('j1');
    // The snapshot (both the return value AND what's persisted) reflects the
    // TRUE before/deducted/after (1/1/0), not the intended 10/2/8 — this is
    // exactly what stops cancel's reversal from over-crediting on-hand.
    expect(res).toEqual({
      ok: true,
      alreadyDone: false,
      deductions: [{ sku: 'SKU-A', before: 1, deducted: 1, after: 0 }],
    });
    expect(jobsUpdates[1]).toEqual({
      stock_deductions: [{ sku: 'SKU-A', before: 1, deducted: 1, after: 0 }],
    });
  });

  it('does not fail the prep when the snapshot follow-up write itself errors — the claimed deduction still returns to the caller', async () => {
    const jobsUpdates: Record<string, unknown>[] = [];
    // A db whose SECOND 'jobs' update (the snapshot write) reports an error —
    // built from makeDb's base behavior via a thin wrapper: makeDb has no
    // knob for this, so this fake reimplements only what's needed, mirroring
    // makeDb's shape for the calls prepareJobMaterials actually makes.
    let jobsUpdateCount = 0;
    currentDb = {
      from(table: string) {
        const state = { op: 'select' as 'select' | 'update', cols: '' };
        const b = {
          update(payload: Record<string, unknown>) {
            state.op = 'update';
            if (table === 'jobs') {
              jobsUpdateCount += 1;
              jobsUpdates.push(payload);
            }
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
              if (jobsUpdateCount === 1) return { data: { id: 'j1' }, error: null }; // claim wins
              return { data: null, error: { message: 'connection reset' } }; // snapshot write fails
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
    quoteRow = { ...quoteRow, is_test: false };
    const res = await prepareJobMaterials('j1');
    // The job IS prepped and the deduction DID happen — only the durable
    // snapshot write failed. The caller still gets the true actual numbers;
    // cancel's legacy-reconstruction fallback covers the DB-side gap (the
    // column stays at its prior null, not a wrong value).
    expect(res).toEqual({
      ok: true,
      alreadyDone: false,
      deductions: [{ sku: 'SKU-A', before: 10, deducted: 2, after: 8 }],
    });
  });
});

describe('prepareJobMaterials — Row 329 claim-error distinguished from alreadyDone', () => {
  it('returns ok:false (never alreadyDone) when the claim UPDATE itself errors', async () => {
    currentDb = makeDb({ claimErrorMsg: 'connection reset' });
    const res = await prepareJobMaterials('j1');
    expect(res).toEqual({
      ok: false,
      error: 'The prep claim update failed — nothing was deducted; safe to retry.',
    });
    expect(adjustOnHandAtomic).not.toHaveBeenCalled();
  });

  it('still returns alreadyDone (not ok:false) for the genuine already-claimed case — no error, just no matching row', async () => {
    currentDb = makeDb({ claimWins: false });
    const res = await prepareJobMaterials('j1');
    expect(res).toEqual({ ok: true, alreadyDone: true });
  });
});
