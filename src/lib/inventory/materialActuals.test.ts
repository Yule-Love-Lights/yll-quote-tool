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
  materials?: { sku: string; qty: number; onHand?: number | null }[];
  // Row 383: the per-prep snapshot (jobs.stock_deductions, row 325). Omitted by
  // default so every pre-existing test keeps exercising the LEGACY fallback
  // path, which is exactly what a legacy job (null column) does in prod.
  stockDeductions?: { sku: string; before: number; deducted: number; after: number }[] | 'pending' | null;
} = {}) {
  const {
    isTest = false,
    stockDecrementedAt = '2026-07-01T00:00:00.000Z',
    stockDeductions = null,
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
      stockDeductions,
      isTest,
    },
    materials: {
      // onHand is the tracked/untracked signal recordMaterialActuals reads from
      // the work order (null == untracked); default 50 == tracked.
      materials: materials.map((m) => ({
        sku: m.sku,
        name: m.sku,
        qty: m.qty,
        onHand: 'onHand' in m ? (m.onHand ?? null) : 50,
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
  prepClaimError?: { message: string } | null;
  onClaim?: () => void;
  onInsert?: (rows: unknown[]) => void;
  insertError?: { message: string } | null;
} = {}) {
  const { claimWins = true, prepClaimWins = true, prepClaimError = null, onClaim, onInsert, insertError = null } = opts;
  let jobsUpdates = 0;
  return {
    from(table: string) {
      if (table === 'jobs') {
        return {
          update() {
            jobsUpdates += 1;
            const isPrepClaim = jobsUpdates === 2;
            const wins = jobsUpdates === 1 ? claimWins : prepClaimWins;
            onClaim?.();
            return {
              eq: () => ({
                is: () => ({
                  select: () => ({
                    maybeSingle: async () =>
                      isPrepClaim && prepClaimError
                        ? { data: null, error: prepClaimError }
                        : wins
                          ? { data: { id: JOB_ID }, error: null }
                          : { data: null, error: null },
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
    // DIFFERENCE (+6 back) — for the REPORTED sku only. SKU-B was not reported,
    // so it stays as prep deducted it (no phantom +5 return).
    expect(res).toEqual({
      ok: true,
      alreadyDone: false,
      trueUps: [{ sku: 'SKU-A', estimated: 10, actual: 4, delta: 6 }],
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

  it('an untracked sku (onHand null on the work order) is skipped, never adjusted', async () => {
    getJobWorkOrderMock.mockResolvedValue(
      makeWo({ materials: [{ sku: 'SKU-A', qty: 10 }, { sku: 'SKU-B', qty: 5, onHand: null }] }),
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

  it('adjusts a reported EXTRA sku not in the BOM but tracked in inventory_on_hand', async () => {
    // materialResolve's catalog-tier fallback: the crew grabbed clips that aren't
    // in this job's projected BOM. It's a real stocked sku, so its deduction must
    // still apply — the BOM-snapshot tracked set alone would wrongly skip it.
    getJobWorkOrderMock.mockResolvedValue(makeWo({ materials: [{ sku: 'SKU-A', qty: 10 }] }));
    listOnHandMock.mockResolvedValue([{ sku: 'SKU-EXTRA' }]);
    const res = await recordMaterialActuals(
      JOB_ID,
      [{ sku: 'SKU-A', qty: 10 }, { sku: 'SKU-EXTRA', qty: 3 }],
      'staff:jason',
    );
    // SKU-A: 10 vs 10 = delta 0 (omitted). SKU-EXTRA: actual-only, full deduction.
    expect(res).toMatchObject({ ok: true, alreadyDone: false, skipped: [] });
    expect((res as { trueUps: unknown[] }).trueUps).toContainEqual({
      sku: 'SKU-EXTRA',
      estimated: 0,
      actual: 3,
      delta: -3,
    });
    expect(adjustOnHandAtomicMock).toHaveBeenCalledWith(expect.anything(), 'SKU-EXTRA', -3);
  });

  it('does NOT return an un-reported estimated sku to the shelf (partial actuals)', async () => {
    // Prepped job: BOM = SKU-A 10, SKU-B 5. Crew reports only SKU-A. SKU-B must
    // stay as prep deducted it — NOT credited back — or every partial report
    // inflates on-hand for everything the crew didn't re-list.
    getJobWorkOrderMock.mockResolvedValue(
      makeWo({ materials: [{ sku: 'SKU-A', qty: 10 }, { sku: 'SKU-B', qty: 5 }] }),
    );
    const res = await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 10 }], 'staff:jason');
    expect(res).toEqual({ ok: true, alreadyDone: false, trueUps: [], skipped: [] });
    expect(adjustOnHandAtomicMock).not.toHaveBeenCalled();
  });

  it('records the actuals but does NOT move stock when the prep-claim takeover errors', async () => {
    getJobWorkOrderMock.mockResolvedValue(makeWo({ stockDecrementedAt: null }));
    let insertedRows: unknown[] = [];
    // Unprepped job; the SECOND jobs update (the stock_decremented_at takeover)
    // returns an error. We can't tell if prep won or the write failed, so stock
    // must be left alone rather than trued up in the wrong direction.
    currentDb = makeDb({ prepClaimError: { message: 'network' }, onInsert: (rows) => { insertedRows = rows; } });
    const res = await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 4 }], 'staff:jason');
    expect(res).toEqual({ ok: true, alreadyDone: false, trueUps: [], skipped: [], baselineUnavailable: true });
    expect(adjustOnHandAtomicMock).not.toHaveBeenCalled();
    expect(insertedRows.length).toBe(1); // actuals still recorded
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
// ── Row 383: the baseline is what prep ACTUALLY deducted ────────────────────
//
// The KNOWN LIMITATION this closes: the baseline used to be re-derived from the
// design as it stands NOW, so it drifted whenever the design changed between
// prep and completion — and, worse, it ignored the on-hand floor. Row 325's
// per-prep snapshot (jobs.stock_deductions) is the accurate record.
describe('recordMaterialActuals — prep snapshot baseline (row 383)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listOnHandMock.mockResolvedValue([]);
    adjustOnHandAtomicMock.mockResolvedValue(undefined);
  });

  // THE money case. Prep was SHORT: 10 needed, only 2 on the shelf, so only 2
  // came off. Crew reports all 10 used.
  //   old (live projection): estimate 10 − actual 10 = 0 → nothing moves, and
  //                          8 units are never deducted from stock at all.
  //   new (prep snapshot)  : estimate  2 − actual 10 = −8 → the 8 come off.
  it('uses the DEDUCTED quantity, so a short prep is trued up instead of silently ignored', async () => {
    getJobWorkOrderMock.mockResolvedValue(
      makeWo({
        materials: [{ sku: 'SKU-A', qty: 10, onHand: 50 }],
        stockDeductions: [{ sku: 'SKU-A', before: 2, deducted: 2, after: 0 }],
      }),
    );

    const res = await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 10 }], 'crew-1');

    expect(res?.ok).toBe(true);
    if (!res || !res.ok || res.alreadyDone) return;
    expect(res.trueUps).toEqual([expect.objectContaining({ sku: 'SKU-A', estimated: 2, actual: 10, delta: -8 })]);
    expect(adjustOnHandAtomicMock).toHaveBeenCalledWith(expect.anything(), 'SKU-A', -8);
  });

  // The design changed between prep and completion: today's projection says 4,
  // but prep really took 10 off the shelf. The credit must be measured against
  // what left the shelf, not against a design nobody prepped from.
  it('measures against the snapshot when the design changed after prep', async () => {
    getJobWorkOrderMock.mockResolvedValue(
      makeWo({
        materials: [{ sku: 'SKU-A', qty: 4, onHand: 50 }],
        stockDeductions: [{ sku: 'SKU-A', before: 50, deducted: 10, after: 40 }],
      }),
    );

    const res = await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 6 }], 'crew-1');

    expect(res?.ok).toBe(true);
    if (!res || !res.ok || res.alreadyDone) return;
    // 10 deducted, 6 used → 4 back on the shelf. Against the live projection it
    // would have been 4 − 6 = −2, deducting 2 MORE for a job that over-prepped.
    expect(res.trueUps).toEqual([expect.objectContaining({ sku: 'SKU-A', estimated: 10, actual: 6, delta: 4 })]);
    expect(adjustOnHandAtomicMock).toHaveBeenCalledWith(expect.anything(), 'SKU-A', 4);
  });

  // Row 325's contract has THREE states, and only a real array is trustworthy.
  it('falls back to the live projection on the PENDING sentinel (snapshot write never landed)', async () => {
    getJobWorkOrderMock.mockResolvedValue(
      makeWo({ materials: [{ sku: 'SKU-A', qty: 10, onHand: 50 }], stockDeductions: 'pending' }),
    );

    const res = await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 6 }], 'crew-1');

    expect(res?.ok).toBe(true);
    if (!res || !res.ok || res.alreadyDone) return;
    expect(res.trueUps).toEqual([expect.objectContaining({ estimated: 10, actual: 6, delta: 4 })]);
  });

  it('falls back to the live projection on a LEGACY job (null column, prepped before row 325)', async () => {
    getJobWorkOrderMock.mockResolvedValue(
      makeWo({ materials: [{ sku: 'SKU-A', qty: 10, onHand: 50 }], stockDeductions: null }),
    );

    const res = await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 6 }], 'crew-1');

    expect(res?.ok).toBe(true);
    if (!res || !res.ok || res.alreadyDone) return;
    expect(res.trueUps).toEqual([expect.objectContaining({ estimated: 10, actual: 6, delta: 4 })]);
  });

  // An EMPTY snapshot is a real answer ("prep deducted nothing"), unlike an
  // empty projection, which may just be a swallowed read. It must not trip the
  // baseline-unavailable bail-out, or the crew's usage never comes off stock.
  it('trusts an EMPTY snapshot and still trues up, rather than bailing out', async () => {
    getJobWorkOrderMock.mockResolvedValue(
      makeWo({ materials: [{ sku: 'SKU-A', qty: 10, onHand: 50 }], stockDeductions: [] }),
    );

    const res = await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 3 }], 'crew-1');

    expect(res?.ok).toBe(true);
    if (!res || !res.ok || res.alreadyDone) return;
    expect(res.baselineUnavailable).toBeUndefined();
    expect(res.trueUps).toEqual([expect.objectContaining({ sku: 'SKU-A', estimated: 0, actual: 3, delta: -3 })]);
  });

  // ...whereas an empty PROJECTION on a prepped job is still distrusted.
  it('still bails out on an empty FALLBACK baseline for a prepped job', async () => {
    getJobWorkOrderMock.mockResolvedValue(makeWo({ materials: [], stockDeductions: null }));

    const res = await recordMaterialActuals(JOB_ID, [{ sku: 'SKU-A', qty: 3 }], 'crew-1');

    expect(res?.ok).toBe(true);
    if (!res || !res.ok || res.alreadyDone) return;
    expect(res.baselineUnavailable).toBe(true);
    expect(adjustOnHandAtomicMock).not.toHaveBeenCalled();
  });
});
