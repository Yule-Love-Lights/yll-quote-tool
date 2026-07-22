// Tests for materialActuals.ts — the stock true-up from field-reported actuals
// (text-ops bot Phase 2, ledger #168). computeMaterialTrueUps is pure (its own
// describe block below); recordMaterialActuals' claim + apply shape mirrors
// prepareJobMaterials (jobs.ts), so the mocking style mirrors jobsPrepare.test.ts
// and the route.test.ts stub-getJobWorkOrder-directly pattern (WT-31).

import { describe, it, expect, beforeEach, vi } from 'vitest';

let currentDb: unknown = null;

const { getJobWorkOrderMock, listOnHandMock, adjustOnHandAtomicMock } = vi.hoisted(() => ({
  getJobWorkOrderMock: vi.fn(),
  listOnHandMock: vi.fn(async () => [] as { sku: string }[]),
  adjustOnHandAtomicMock: vi.fn(async () => {}),
}));

vi.mock('../supabase', () => ({ getSupabaseServiceClient: () => currentDb }));
vi.mock('./jobs', () => ({ getJobWorkOrder: getJobWorkOrderMock }));
// Keep the real toQty (a pure helper computeMaterialTrueUps itself relies on);
// only listOnHand / adjustOnHandAtomic are IO seams that need stubbing.
vi.mock('./onHand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./onHand')>();
  return { ...actual, listOnHand: listOnHandMock, adjustOnHandAtomic: adjustOnHandAtomicMock };
});

import { computeMaterialTrueUps, recordMaterialActuals } from './materialActuals';

// ── recordMaterialActuals fixtures ───────────────────────────────────────────

const JOB_ID = 'j1';

function makeWo(overrides: {
  isTest?: boolean;
  stockDecrementedAt?: string | null;
  materials?: { sku: string; qty: number }[];
} = {}) {
  const {
    isTest = false,
    stockDecrementedAt = '2026-07-01T00:00:00.000Z',
    materials = [
      { sku: 'SKU-A', qty: 10 },
      { sku: 'SKU-B', qty: 5 },
    ],
  } = overrides;
  return {
    job: {
      id: JOB_ID,
      jobNumber: 1000,
      quoteId: 'q1',
      designId: null,
      stage: 'to_be_prepared' as const,
      status: 'to_schedule' as const,
      installDate: null,
      customerName: 'Test Customer',
      customerAddress: '1 Test St',
      stockDecrementedAt,
      isTest,
    },
    materials: {
      materials: materials.map((m) => ({
        sku: m.sku,
        name: m.sku,
        qty: m.qty,
        onHand: 50,
        short: false,
        locked: false,
      })),
      unbound: [],
      totalLines: materials.length,
    },
  };
}

// A db fake whose `jobs` chain terminates in .maybeSingle() (the atomic
// materials_actualized_at claim, mirroring prepareJobMaterials' stock claim)
// and whose `job_material_actuals` chain is a bare insert() the caller awaits
// directly. `onClaim` / `onInsert` let a test assert a write was NEVER attempted.
// On an UNPREPPED job the module makes a SECOND guarded `jobs` update, taking
// over prep's stock_decremented_at claim so prep can't deduct on top of the
// actuals. `prepClaimWins: false` simulates prep winning that race.
function makeDb(opts: {
  claimWins?: boolean;
  prepClaimWins?: boolean;
  onClaim?: () => void;
  onInsert?: (rows: unknown[]) => void;
  insertError?: { message: string } | null;
} = {}) {
  const { claimWins = true, prepClaimWins = true, onClaim, onInsert, insertError = null } = opts;
  let jobsUpdates = 0;
  return {
    from(table: string) {
      if (table === 'jobs') {
        return {
          update() {
            jobsUpdates += 1;
            const wins = jobsUpdates === 1 ? claimWins : prepClaimWins;
            onClaim?.();
            return {
              eq: () => ({
                is: () => ({
                  select: () => ({
                    maybeSingle: async () =>
                      wins ? { data: { id: JOB_ID }, error: null } : { data: null, error: null },
                  }),
                }),
              }),
            };
          },
        };
      }
      if (table === 'job_material_actuals') {
        return {
          insert: async (rows: unknown[]) => {
            onInsert?.(rows);
            return { error: insertError };
          },
        };
      }
      throw new Error(`materialActuals.test.ts: unexpected table ${table}`);
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentDb = makeDb();
  getJobWorkOrderMock.mockResolvedValue(makeWo());
  listOnHandMock.mockResolvedValue([{ sku: 'SKU-A' }, { sku: 'SKU-B' }]);
});

// ── pure: computeMaterialTrueUps ─────────────────────────────────────────────

describe('computeMaterialTrueUps (pure)', () => {
  it('used LESS than estimated → positive delta (stock comes back)', () => {
    expect(computeMaterialTrueUps([{ sku: 'A', qty: 10 }], [{ sku: 'A', qty: 6 }])).toEqual([
      { sku: 'A', estimated: 10, actual: 6, delta: 4 },
    ]);
  });

  it('used MORE than estimated → negative delta (more comes off stock)', () => {
    expect(computeMaterialTrueUps([{ sku: 'A', qty: 4 }], [{ sku: 'A', qty: 10 }])).toEqual([
      { sku: 'A', estimated: 4, actual: 10, delta: -6 },
    ]);
  });

  it('sku only in actual → estimated treated as 0 (a full deduction)', () => {
    expect(computeMaterialTrueUps([], [{ sku: 'X', qty: 3 }])).toEqual([
      { sku: 'X', estimated: 0, actual: 3, delta: -3 },
    ]);
  });

  it('sku only in estimated → actual treated as 0 (unused material returns)', () => {
    expect(computeMaterialTrueUps([{ sku: 'Y', qty: 5 }], [])).toEqual([
      { sku: 'Y', estimated: 5, actual: 0, delta: 5 },
    ]);
  });

  it('sums duplicate skus within each input before comparing', () => {
    expect(
      computeMaterialTrueUps(
        [{ sku: 'A', qty: 2 }, { sku: 'A', qty: 3 }], // estimated sums to 5
        [{ sku: 'A', qty: 1 }, { sku: 'A', qty: 1 }], // actual sums to 2
      ),
    ).toEqual([{ sku: 'A', estimated: 5, actual: 2, delta: 3 }]);
  });

  it('omits a zero-delta row', () => {
    expect(computeMaterialTrueUps([{ sku: 'A', qty: 5 }], [{ sku: 'A', qty: 5 }])).toEqual([]);
  });

  it('floors non-finite / negative / fractional qty to a non-negative integer', () => {
    expect(
      computeMaterialTrueUps(
        [{ sku: 'A', qty: -3 }], // floors to 0
        [{ sku: 'A', qty: 2.7 }], // floors to 2
      ),
    ).toEqual([{ sku: 'A', estimated: 0, actual: 2, delta: -2 }]);
    expect(
      computeMaterialTrueUps([{ sku: 'B', qty: Number.NaN }], [{ sku: 'B', qty: Number.POSITIVE_INFINITY }]),
    ).toEqual([]); // both floor to 0 → zero delta → omitted
  });
});

// ── recordMaterialActuals ─────────────────────────────────────────────────────

describe('recordMaterialActuals', () => {
  it('returns null and never reads/writes when Supabase is not configured', async () => {
    currentDb = null;
    const res = await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 4 }], 'staff:jason');
    expect(res).toBeNull();
    expect(getJobWorkOrderMock).not.toHaveBeenCalled();
  });

  it('a read failure (getJobWorkOrder → null) writes NOTHING and returns null, retryable', async () => {
    getJobWorkOrderMock.mockResolvedValueOnce(null);
    let claimAttempted = false;
    let insertAttempted = false;
    currentDb = makeDb({
      onClaim: () => { claimAttempted = true; },
      onInsert: () => { insertAttempted = true; },
    });
    const res = await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 4 }], 'staff:jason');
    expect(res).toBeNull();
    expect(claimAttempted).toBe(false);
    expect(insertAttempted).toBe(false);
    expect(adjustOnHandAtomicMock).not.toHaveBeenCalled();
  });

  it('alreadyDone when the idempotency claim is already taken — applies nothing', async () => {
    currentDb = makeDb({ claimWins: false });
    const res = await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 4 }], 'staff:jason');
    expect(res).toEqual({ ok: true, alreadyDone: true });
    expect(adjustOnHandAtomicMock).not.toHaveBeenCalled();
  });

  it('prep never ran (stockDecrementedAt null) → the FULL actual is deducted', async () => {
    getJobWorkOrderMock.mockResolvedValue(makeWo({ stockDecrementedAt: null }));
    const res = await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 4 }], 'staff:jason');
    expect(res).toEqual({
      ok: true,
      alreadyDone: false,
      trueUps: [{ sku: 'SKU-A', estimated: 0, actual: 4, delta: -4 }],
      skipped: [],
    });
    expect(adjustOnHandAtomicMock).toHaveBeenCalledWith(expect.anything(), 'SKU-A', -4);
  });

  it('closing an unprepped job takes over prep\'s claim so prep cannot deduct again', async () => {
    getJobWorkOrderMock.mockResolvedValue(makeWo({ stockDecrementedAt: null }));
    let jobsUpdates = 0;
    currentDb = makeDb({ onClaim: () => { jobsUpdates += 1; } });
    await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 4 }], 'staff:jason');
    // Two guarded writes: the materials_actualized_at claim, then the takeover
    // of stock_decremented_at. Without the second, a later Prep click would
    // deduct the estimated BOM on top of the actual we just took off.
    expect(jobsUpdates).toBe(2);
  });

  it('keeps the ESTIMATE baseline when prep wins the race after our read', async () => {
    getJobWorkOrderMock.mockResolvedValue(makeWo({ stockDecrementedAt: null }));
    currentDb = makeDb({ prepClaimWins: false });
    const res = await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 4 }], 'staff:jason');
    // Prep slipped in and deducted the estimated 10, so the true-up is the
    // DIFFERENCE (+6 back), not another full -4 deduction.
    expect(res).toEqual({
      ok: true,
      alreadyDone: false,
      trueUps: [
        { sku: 'SKU-A', estimated: 10, actual: 4, delta: 6 },
        { sku: 'SKU-B', estimated: 5, actual: 0, delta: 5 },
      ],
      skipped: [],
    });
  });

  it('does NOT re-stamp the prep claim on a job that was already prepped', async () => {
    let jobsUpdates = 0;
    currentDb = makeDb({ onClaim: () => { jobsUpdates += 1; } });
    await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 4 }], 'staff:jason');
    expect(jobsUpdates).toBe(1);
  });

  it('a test job records the audit rows but adjusts NO stock', async () => {
    getJobWorkOrderMock.mockResolvedValue(makeWo({ isTest: true }));
    let insertedRows: unknown[] = [];
    currentDb = makeDb({ onInsert: (rows) => { insertedRows = rows; } });
    const res = await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 4 }], 'staff:jason');
    expect(res).toEqual({ ok: true, alreadyDone: false, trueUps: [], skipped: [] });
    expect(insertedRows).toEqual([
      { job_id: JOB_ID, sku: 'SKU-A', qty: 4, estimated_qty: 0, raw_text: null, recorded_by: 'staff:jason' },
    ]);
    expect(adjustOnHandAtomicMock).not.toHaveBeenCalled();
  });

  it('an untracked sku (not in inventory_on_hand) is skipped, never adjusted', async () => {
    listOnHandMock.mockResolvedValue([{ sku: 'SKU-A' }]); // SKU-B not tracked
    getJobWorkOrderMock.mockResolvedValue(
      makeWo({ materials: [{ sku: 'SKU-A', qty: 10 }, { sku: 'SKU-B', qty: 5 }] }),
    );
    const res = await recordMaterialActuals(
      JOB_ID,
      [{ sku: 'SKU-A', qty: 6 }, { sku: 'SKU-B', qty: 1, rawText: '1 box SKU-B' }],
      'staff:jason',
    );
    expect(res).toEqual({
      ok: true,
      alreadyDone: false,
      trueUps: [{ sku: 'SKU-A', estimated: 10, actual: 6, delta: 4 }],
      skipped: ['SKU-B'],
    });
    expect(adjustOnHandAtomicMock).toHaveBeenCalledTimes(1);
    expect(adjustOnHandAtomicMock).toHaveBeenCalledWith(expect.anything(), 'SKU-A', 4);
  });

  it('one failing adjustOnHandAtomic does not stop the other tracked skus from being applied', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    adjustOnHandAtomicMock.mockRejectedValueOnce(new Error('db write failed'));
    getJobWorkOrderMock.mockResolvedValue(
      makeWo({ materials: [{ sku: 'SKU-A', qty: 10 }, { sku: 'SKU-B', qty: 5 }] }),
    );
    const res = await recordMaterialActuals(
      JOB_ID,
      [{ sku: 'SKU-A', qty: 6 }, { sku: 'SKU-B', qty: 2 }],
      'staff:jason',
    );
    // Both true-ups are still REPORTED (mirrors prepareJobMaterials' deductions
    // list — the caller sees the intended adjustment even where the write failed
    // and staff must reconcile manually).
    expect(res).toEqual({
      ok: true,
      alreadyDone: false,
      trueUps: [
        { sku: 'SKU-A', estimated: 10, actual: 6, delta: 4 },
        { sku: 'SKU-B', estimated: 5, actual: 2, delta: 3 },
      ],
      skipped: [],
    });
    expect(adjustOnHandAtomicMock).toHaveBeenCalledTimes(2);
    expect(adjustOnHandAtomicMock).toHaveBeenNthCalledWith(1, expect.anything(), 'SKU-A', 4);
    expect(adjustOnHandAtomicMock).toHaveBeenNthCalledWith(2, expect.anything(), 'SKU-B', 3);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('a failed audit-row insert does not abort the stock true-up', async () => {
    currentDb = makeDb({ insertError: { message: 'insert boom' } });
    getJobWorkOrderMock.mockResolvedValue(makeWo({ materials: [{ sku: 'SKU-A', qty: 10 }] }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 6 }], 'staff:jason');
    expect(res).toEqual({
      ok: true,
      alreadyDone: false,
      trueUps: [{ sku: 'SKU-A', estimated: 10, actual: 6, delta: 4 }],
      skipped: [],
    });
    expect(adjustOnHandAtomicMock).toHaveBeenCalledWith(expect.anything(), 'SKU-A', 4);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
