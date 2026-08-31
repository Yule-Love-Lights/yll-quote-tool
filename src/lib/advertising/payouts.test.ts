// Advertising payout settlement (ledger row 481). The tool knew what every
// worker had EARNED; these tests pin what it now knows about the money
// actually being HANDED OVER.
//
// The eight money traps from the build spec, written before the module
// existed. The mock database enforces the one constraint the whole design
// rests on — placement_id is UNIQUE across settlement lines — so a test can
// tell a real refusal from a hopeful one.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type AnyRow = Record<string, unknown>;

const { dbRef, stateRef, logAdvertisingActivity, getAdvertisingWorker, earningsSummaryOrThrow } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  stateRef: {
    current: {
      placements: [] as AnyRow[],
      settlements: [] as AnyRow[],
      lines: [] as AnyRow[],
      placementWrites: 0, // any update/insert against advertising_placements
      // When set, the NEXT settlement_lines insert drops this many rows
      // silently — models a write that lands partially.
      dropLinesOnce: 0,
      // Fires ONCE as the settlement lines land, before the write verifies
      // itself — models a void winning the gap after the placements were read.
      onLinesInsertOnce: null as null | (() => void),
      // How many of the next settlement deletes should fail. A delete that
      // can never fail leaves the unwind's retry and its two messages
      // untestable, which is how an unprobed guard ships.
      failSettlementDeletes: 0,
      seq: 0,
    },
  },
  logAdvertisingActivity: vi.fn(),
  getAdvertisingWorker: vi.fn(),
  earningsSummaryOrThrow: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => dbRef.current }));
vi.mock('@/lib/advertising/activity', () => ({ logAdvertisingActivity }));
vi.mock('@/lib/advertising/workers', () => ({ getAdvertisingWorker }));
vi.mock('@/lib/advertising/placements', () => ({ earningsSummaryOrThrow }));

import {
  getWorkerPayoutSummary,
  listPayablePlacements,
  listSettlements,
  listPayoutSummaries,
  recordSettlement,
  SETTLEMENT_METHODS,
} from './payouts';

function id() {
  stateRef.current.seq += 1;
  return `id-${stateRef.current.seq}`;
}

function rowsFor(table: string): AnyRow[] {
  if (table === 'advertising_placements') return stateRef.current.placements;
  if (table === 'advertising_settlements') return stateRef.current.settlements;
  if (table === 'advertising_settlement_lines') return stateRef.current.lines;
  throw new Error(`unexpected table ${table}`);
}

type Pred = (row: AnyRow) => boolean;

/** A small in-memory PostgREST: eq / is / in / order / range / maybeSingle,
 * insert (single or array, atomic), delete. The settlement_lines unique
 * index on placement_id is enforced here, because a mock that cannot refuse
 * a duplicate cannot test the guarantee the schema exists to make. */
function makeDb() {
  return {
    from(table: string) {
      return {
        select(_cols?: string) {
          const preds: Pred[] = [];
          const b = {
            eq(col: string, val: unknown) {
              preds.push((r) => r[col] === val);
              return b;
            },
            is(col: string, val: unknown) {
              preds.push((r) => (val === null ? r[col] == null : r[col] === val));
              return b;
            },
            in(col: string, vals: unknown[]) {
              preds.push((r) => vals.includes(r[col]));
              return b;
            },
            order() {
              return b;
            },
            range(from: number, to: number) {
              const all = rowsFor(table).filter((r) => preds.every((p) => p(r)));
              return Promise.resolve({ data: all.slice(from, to + 1), error: null });
            },
            maybeSingle() {
              const all = rowsFor(table).filter((r) => preds.every((p) => p(r)));
              return Promise.resolve({ data: all[0] ?? null, error: null });
            },
          };
          return b;
        },
        insert(payload: AnyRow | AnyRow[]) {
          if (table === 'advertising_placements') stateRef.current.placementWrites += 1;
          const incoming: AnyRow[] = (Array.isArray(payload) ? payload : [payload]).map((p) => ({
            id: id(),
            created_at: new Date().toISOString(),
            // The column defaults the schema fills in. Several of these
            // rows are inserted inside the same millisecond, which is
            // exactly the tie the ordering has to survive.
            ...(table === 'advertising_settlements' ? { paid_at: new Date().toISOString() } : {}),
            ...p,
          }));

          // The unique index on advertising_settlement_lines.placement_id.
          if (table === 'advertising_settlement_lines') {
            const taken = new Set(stateRef.current.lines.map((r) => r.placement_id));
            const seen = new Set<unknown>();
            for (const row of incoming) {
              if (taken.has(row.placement_id) || seen.has(row.placement_id)) {
                return {
                  select: () => ({
                    // Postgres rejects the whole statement: nothing lands.
                    then: (resolve: (v: unknown) => void) =>
                      Promise.resolve({
                        data: null,
                        error: {
                          code: '23505',
                          message:
                            'duplicate key value violates unique constraint "advertising_settlement_lines_placement_key"',
                        },
                      }).then(resolve),
                  }),
                };
              }
              seen.add(row.placement_id);
            }
          }

          const drop = table === 'advertising_settlement_lines' ? stateRef.current.dropLinesOnce : 0;
          if (drop > 0) stateRef.current.dropLinesOnce = 0;
          const landed = drop > 0 ? incoming.slice(0, Math.max(0, incoming.length - drop)) : incoming;
          rowsFor(table).push(...landed);

          if (table === 'advertising_settlement_lines') {
            const hook = stateRef.current.onLinesInsertOnce;
            if (hook) {
              stateRef.current.onLinesInsertOnce = null;
              hook();
            }
          }

          const result = { data: Array.isArray(payload) ? landed : (landed[0] ?? null), error: null };
          return {
            select: () => ({
              maybeSingle: () => Promise.resolve({ data: landed[0] ?? null, error: null }),
              then: (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve),
            }),
            then: (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve),
          };
        },
        delete() {
          const preds: Pred[] = [];
          const d = {
            eq(col: string, val: unknown) {
              preds.push((r) => r[col] === val);
              return d;
            },
            then(resolve: (v: { error: { message: string } | null }) => void) {
              if (table === 'advertising_settlements' && stateRef.current.failSettlementDeletes > 0) {
                stateRef.current.failSettlementDeletes -= 1;
                return Promise.resolve({ error: { message: 'connection reset by peer' } }).then(resolve);
              }
              const rows = rowsFor(table);
              const removed: AnyRow[] = [];
              for (let i = rows.length - 1; i >= 0; i--) {
                if (preds.every((p) => p(rows[i]))) removed.push(...rows.splice(i, 1));
              }
              // advertising_settlement_lines.settlement_id is ON DELETE
              // CASCADE: removing a settlement takes its lines with it.
              if (table === 'advertising_settlements') {
                const gone = new Set(removed.map((r) => r.id));
                stateRef.current.lines = stateRef.current.lines.filter((l) => !gone.has(l.settlement_id));
              }
              return Promise.resolve({ error: null }).then(resolve);
            },
          };
          return d;
        },
      };
    },
  };
}

function seedPlacement(over: AnyRow = {}): AnyRow {
  const row: AnyRow = {
    id: id(),
    worker_id: 'worker-1',
    campaign_id: 'camp-1',
    status: 'accepted',
    kind: 'yard_sign',
    accepted_rate_cents: 250,
    captured_at: '2026-08-20T15:00:00.000Z',
    reviewed_at: '2026-08-21T15:00:00.000Z',
    created_at: '2026-08-20T15:00:00.000Z',
    voided_at: null,
    is_test: false,
    ...over,
  };
  stateRef.current.placements.push(row);
  return row;
}

/** Point the earnings engine at the seeded rows so earned and settled are
 * derived from ONE set of facts, the way production does it. */
function earnedFromSeed() {
  const byWorker = new Map<string, number>();
  for (const p of stateRef.current.placements) {
    if (p.is_test) continue;
    // summarizeEarnings MINTS an entry for every real placement's worker
    // before it skips voided or unaccepted rows, so a worker whose photos are
    // all voided still appears with zeros instead of vanishing. Modelled here
    // because the difference between "zero earned" and "no row at all" is
    // what the empty-earnings-read guard keys on.
    const worker = String(p.worker_id);
    if (!byWorker.has(worker)) byWorker.set(worker, 0);
    if (p.voided_at || p.status !== 'accepted') continue;
    byWorker.set(worker, (byWorker.get(worker) ?? 0) + Number(p.accepted_rate_cents ?? 0));
  }
  return [...byWorker.entries()].map(([workerId, cents]) => ({
    workerId,
    total: { pendingEstimatedCents: 0, acceptedEarnedCents: cents },
    byDay: [],
    byWeek: [],
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  stateRef.current.placements = [];
  stateRef.current.settlements = [];
  stateRef.current.lines = [];
  stateRef.current.placementWrites = 0;
  stateRef.current.dropLinesOnce = 0;
  stateRef.current.onLinesInsertOnce = null;
  stateRef.current.failSettlementDeletes = 0;
  stateRef.current.seq = 0;
  dbRef.current = makeDb();
  getAdvertisingWorker.mockImplementation(async (workerId: string) => ({
    id: workerId,
    displayName: workerId === 'worker-test' ? 'Test Rig' : 'Joe Signs',
    authUserId: null,
    active: true,
    isTest: workerId === 'worker-test',
    createdAt: 'x',
    updatedAt: 'x',
  }));
  earningsSummaryOrThrow.mockImplementation(async (opts?: { workerId?: string }) => {
    const all = earnedFromSeed();
    return opts?.workerId ? all.filter((s) => s.workerId === opts.workerId) : all;
  });
});

describe('trap 1 — unpaid is earned minus settled, in integer cents', () => {
  it('derives unpaid per worker and never stores it', async () => {
    const a = seedPlacement({ accepted_rate_cents: 250 });
    seedPlacement({ accepted_rate_cents: 250 });
    seedPlacement({ accepted_rate_cents: 175 });

    const before = await getWorkerPayoutSummary('worker-1');
    expect(before.earnedCents).toBe(675);
    expect(before.settledCents).toBe(0);
    expect(before.unpaidCents).toBe(675);
    expect(before.lastPaidAt).toBeNull();

    await recordSettlement('worker-1', [String(a.id)], 'admin-1', { method: 'cash' });

    const after = await getWorkerPayoutSummary('worker-1');
    expect(after.earnedCents).toBe(675);
    expect(after.settledCents).toBe(250);
    expect(after.unpaidCents).toBe(425);
    expect(after.lastPaidAt).not.toBeNull();
  });

  it('unpaid always equals the sum of what is still payable', async () => {
    seedPlacement({ accepted_rate_cents: 250 });
    const b = seedPlacement({ accepted_rate_cents: 300 });
    await recordSettlement('worker-1', [String(b.id)], 'admin-1', { method: 'venmo' });

    const summary = await getWorkerPayoutSummary('worker-1');
    const payable = await listPayablePlacements('worker-1');
    const payableTotal = payable.reduce((sum, p) => sum + p.amountCents, 0);
    expect(payableTotal).toBe(summary.unpaidCents);
    expect(payableTotal).toBe(250);
  });
});

describe('trap 2 — a placement is paid at most once', () => {
  it('refuses a second settlement naming an already-paid photo', async () => {
    const a = seedPlacement();
    await recordSettlement('worker-1', [String(a.id)], 'admin-1', { method: 'cash' });

    await expect(recordSettlement('worker-1', [String(a.id)], 'admin-1', { method: 'cash' })).rejects.toThrow(
      /already been paid/i,
    );
    expect(stateRef.current.settlements).toHaveLength(1);
    expect(stateRef.current.lines).toHaveLength(1);
  });

  it('a paid photo is no longer payable', async () => {
    const a = seedPlacement();
    const b = seedPlacement();
    await recordSettlement('worker-1', [String(a.id)], 'admin-1', { method: 'check' });

    const payable = await listPayablePlacements('worker-1');
    expect(payable.map((p) => p.id)).toEqual([String(b.id)]);
  });

  it('surfaces a lost race as a named conflict, not a crash, and leaves no orphan settlement', async () => {
    const a = seedPlacement();
    // Another admin's settlement landed between our read and our write.
    stateRef.current.lines.push({ id: id(), settlement_id: 'other', placement_id: a.id, amount_cents: 250 });

    await expect(recordSettlement('worker-1', [String(a.id)], 'admin-1', { method: 'cash' })).rejects.toThrow(
      /paid a moment ago|already been paid/i,
    );
    expect(stateRef.current.settlements).toHaveLength(0);
  });
});

describe('trap 3 — settling never changes what was earned', () => {
  it('writes nothing to the placements table and leaves earned untouched', async () => {
    const a = seedPlacement({ accepted_rate_cents: 250 });
    const earnedBefore = (await getWorkerPayoutSummary('worker-1')).earnedCents;

    await recordSettlement('worker-1', [String(a.id)], 'admin-1', { method: 'cash' });

    expect(stateRef.current.placementWrites).toBe(0);
    expect((await getWorkerPayoutSummary('worker-1')).earnedCents).toBe(earnedBefore);
  });
});

describe('trap 4 — voided placements and money', () => {
  it('never offers a voided placement as payable, and refuses one named directly', async () => {
    const voided = seedPlacement({ voided_at: '2026-08-22T12:00:00.000Z' });
    seedPlacement();

    const payable = await listPayablePlacements('worker-1');
    expect(payable.map((p) => p.id)).not.toContain(String(voided.id));

    await expect(recordSettlement('worker-1', [String(voided.id)], 'admin-1', { method: 'cash' })).rejects.toThrow(
      /voided/i,
    );
  });

  it('a placement voided after it was paid does not reduce the past settlement', async () => {
    const a = seedPlacement({ accepted_rate_cents: 250 });
    const settlement = await recordSettlement('worker-1', [String(a.id)], 'admin-1', { method: 'cash' });

    // Void arrives afterwards anyway (a pre-existing row, or a race the void
    // guard lost): the money we handed over is history and does not move.
    a.voided_at = '2026-08-23T12:00:00.000Z';

    const summary = await getWorkerPayoutSummary('worker-1');
    expect(summary.settledCents).toBe(250);
    const stored = stateRef.current.settlements.find((s) => s.id === settlement.id);
    expect(stored?.total_cents).toBe(250);
    expect(stateRef.current.lines).toHaveLength(1);
  });
});

describe('trap 5 — a double-submitted Mark paid records one settlement', () => {
  it('records one settlement and one set of lines when the same submit fires twice', async () => {
    const a = seedPlacement({ accepted_rate_cents: 250 });
    const b = seedPlacement({ accepted_rate_cents: 300 });
    const ids = [String(a.id), String(b.id)];

    const results = await Promise.allSettled([
      recordSettlement('worker-1', ids, 'admin-1', { method: 'cash' }),
      recordSettlement('worker-1', ids, 'admin-1', { method: 'cash' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(stateRef.current.settlements).toHaveLength(1);
    expect(stateRef.current.lines).toHaveLength(2);
    expect((await getWorkerPayoutSummary('worker-1')).settledCents).toBe(550);
  });
});

describe('trap 6 — test workers and test rows never enter a real settlement', () => {
  it('refuses to pay a test worker', async () => {
    const t = seedPlacement({ worker_id: 'worker-test', is_test: true });
    await expect(recordSettlement('worker-test', [String(t.id)], 'admin-1', { method: 'cash' })).rejects.toThrow(
      /test worker/i,
    );
    expect(stateRef.current.settlements).toHaveLength(0);
  });

  it('never lists a test row as payable, even under a real worker', async () => {
    const testRow = seedPlacement({ is_test: true });
    const real = seedPlacement();
    const payable = await listPayablePlacements('worker-1');
    expect(payable.map((p) => p.id)).toEqual([String(real.id)]);
    await expect(recordSettlement('worker-1', [String(testRow.id)], 'admin-1', { method: 'cash' })).rejects.toThrow(
      /test/i,
    );
  });
});

describe('trap 7 — a settlement covering nothing is refused', () => {
  it('refuses an empty selection without writing a $0.00 record', async () => {
    seedPlacement();
    await expect(recordSettlement('worker-1', [], 'admin-1', { method: 'cash' })).rejects.toThrow(/nothing to pay/i);
    expect(stateRef.current.settlements).toHaveLength(0);
  });

  it('refuses a selection whose stamped rates total zero', async () => {
    const free = seedPlacement({ accepted_rate_cents: 0 });
    await expect(recordSettlement('worker-1', [String(free.id)], 'admin-1', { method: 'cash' })).rejects.toThrow(
      /\$0\.00/,
    );
    expect(stateRef.current.settlements).toHaveLength(0);
  });
});

describe('trap 8 — the lines always sum to the settlement total', () => {
  it('stores a total equal to the sum of its lines', async () => {
    const a = seedPlacement({ accepted_rate_cents: 250 });
    const b = seedPlacement({ accepted_rate_cents: 175 });
    const settlement = await recordSettlement('worker-1', [String(a.id), String(b.id)], 'admin-1', { method: 'cash' });

    expect(settlement.totalCents).toBe(425);
    const sum = stateRef.current.lines.reduce((acc, l) => acc + Number(l.amount_cents), 0);
    expect(sum).toBe(425);
    expect(settlement.lineCount).toBe(2);
  });

  it('unwinds the settlement when its lines do not land in full', async () => {
    const a = seedPlacement({ accepted_rate_cents: 250 });
    const b = seedPlacement({ accepted_rate_cents: 175 });
    stateRef.current.dropLinesOnce = 1; // one line silently fails to land

    await expect(
      recordSettlement('worker-1', [String(a.id), String(b.id)], 'admin-1', { method: 'cash' }),
    ).rejects.toThrow(/did not land in full|could not be recorded/i);

    expect(stateRef.current.settlements).toHaveLength(0);
    expect(stateRef.current.lines).toHaveLength(0);
  });
});

describe('a void racing the payment (technical lens, PR #1130)', () => {
  it('retries a failed unwind, and stays quiet when a later attempt succeeds', async () => {
    const a = seedPlacement({ accepted_rate_cents: 250 });
    stateRef.current.onLinesInsertOnce = () => {
      a.voided_at = '2026-08-30T18:00:00.000Z';
    };
    stateRef.current.failSettlementDeletes = 2; // the third attempt lands

    await expect(recordSettlement('worker-1', [String(a.id)], 'admin-1', { method: 'cash' })).rejects.toThrow(
      /voided while this payment was being written/i,
    );
    // The retry did its job, so nothing is left on the books and the caller
    // gets the ordinary refusal, not a call to reconcile anything by hand.
    expect(stateRef.current.settlements).toHaveLength(0);
    expect(stateRef.current.lines).toHaveLength(0);
  });

  it('asks for the row by hand when it cannot remove a payment that DID land', async () => {
    const a = seedPlacement({ accepted_rate_cents: 250 });
    stateRef.current.onLinesInsertOnce = () => {
      a.voided_at = '2026-08-30T18:00:00.000Z';
    };
    stateRef.current.failSettlementDeletes = 99; // every attempt fails

    // The one outcome a person has to fix: the photo is voided and paid at
    // once, so paid and earned disagree until someone reconciles it. "Try
    // again" would be useless advice, so the message must not say that.
    await expect(recordSettlement('worker-1', [String(a.id)], 'admin-1', { method: 'cash' })).rejects.toThrow(
      /reconciled by hand/i,
    );
    expect(stateRef.current.settlements).toHaveLength(1); // it really is still there
  });

  it('refuses and unwinds when a photo is voided while the payment is being written', async () => {
    const a = seedPlacement({ accepted_rate_cents: 250 });
    const b = seedPlacement({ accepted_rate_cents: 300 });

    // voidPlacement's own guard passes at that instant: no settlement line
    // exists yet. Only the settle side can catch this direction.
    stateRef.current.onLinesInsertOnce = () => {
      a.voided_at = '2026-08-30T18:00:00.000Z';
    };

    await expect(
      recordSettlement('worker-1', [String(a.id), String(b.id)], 'admin-1', { method: 'cash' }),
    ).rejects.toThrow(/voided/i);

    // Nothing recorded: the photo is voided and NOT paid, so earned and
    // settled stay consistent and unpaid cannot go negative.
    expect(stateRef.current.settlements).toHaveLength(0);
    expect(stateRef.current.lines).toHaveLength(0);
  });
});

describe('a money read that fails must not render as a number', () => {
  it('refuses rather than reporting a total built on a failed earnings read', async () => {
    const a = seedPlacement({ accepted_rate_cents: 250 });
    await recordSettlement('worker-1', [String(a.id)], 'admin-1', { method: 'cash' });

    // The money path reads earnings through the THROWING variant, so a read
    // failure surfaces as a refusal instead of silently becoming 0 earned and
    // a negative unpaid. The routes turn this into "Could not load pay".
    earningsSummaryOrThrow.mockRejectedValue(new Error('earningsSummary: could not read placements'));

    await expect(getWorkerPayoutSummary('worker-1')).rejects.toThrow(/could not read/i);
    await expect(listPayoutSummaries()).rejects.toThrow(/could not read/i);
  });

  it('protects a worker who has EARNED but never been paid, not only a paid one', async () => {
    seedPlacement({ accepted_rate_cents: 250 }); // earned, never settled
    earningsSummaryOrThrow.mockRejectedValue(new Error('earningsSummary: could not read placements'));

    // The first cut of this guard only fired once money had been paid, which
    // left the larger population, workers still owed, reading as $0 owed on a
    // 200 response (delta-verify, PR #1130).
    await expect(getWorkerPayoutSummary('worker-1')).rejects.toThrow(/could not read/i);
    await expect(listPayoutSummaries()).rejects.toThrow(/could not read/i);
  });
});

describe('the payment record itself', () => {
  it('rejects a method outside the fixed list', async () => {
    const a = seedPlacement();
    await expect(
      recordSettlement('worker-1', [String(a.id)], 'admin-1', { method: 'bitcoin' as never }),
    ).rejects.toThrow(/method/i);
    expect(stateRef.current.settlements).toHaveLength(0);
  });

  it('accepts every method on the list', () => {
    expect([...SETTLEMENT_METHODS]).toEqual(['cash', 'venmo', 'check', 'other']);
  });

  it('audits the payment with its total, line count and the acting admin', async () => {
    const a = seedPlacement({ accepted_rate_cents: 250 });
    await recordSettlement('worker-1', [String(a.id)], 'admin-1', { method: 'venmo', note: 'week of the 17th' });

    expect(logAdvertisingActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'admin-1',
        action: 'settlement_recorded',
        workerId: 'worker-1',
        detail: expect.objectContaining({ totalCents: 250, lineCount: 1, method: 'venmo' }),
      }),
    );
  });

  it('refuses a photo belonging to a different worker', async () => {
    const other = seedPlacement({ worker_id: 'worker-2' });
    await expect(recordSettlement('worker-1', [String(other.id)], 'admin-1', { method: 'cash' })).rejects.toThrow(
      /another worker|does not belong/i,
    );
    expect(stateRef.current.settlements).toHaveLength(0);
  });

  it('refuses a photo that is not accepted', async () => {
    const pending = seedPlacement({ status: 'pending', accepted_rate_cents: null });
    await expect(recordSettlement('worker-1', [String(pending.id)], 'admin-1', { method: 'cash' })).rejects.toThrow(
      /not accepted/i,
    );
  });

  it('lists a worker payment history, newest first, with what each payment covered', async () => {
    const a = seedPlacement({ accepted_rate_cents: 250 });
    const b = seedPlacement({ accepted_rate_cents: 300 });
    await recordSettlement('worker-1', [String(a.id)], 'admin-1', { method: 'cash' });
    await recordSettlement('worker-1', [String(b.id)], 'admin-1', { method: 'check', note: 'cheque 1041' });

    const history = await listSettlements('worker-1');
    expect(history).toHaveLength(2);
    expect(history[0].totalCents).toBe(300);
    expect(history[0].method).toBe('check');
    expect(history[0].note).toBe('cheque 1041');
    expect(history[0].lineCount).toBe(1);
    expect(history[1].totalCents).toBe(250);
  });

  it('summarises every worker for the pay screen', async () => {
    const a = seedPlacement({ accepted_rate_cents: 250 });
    seedPlacement({ worker_id: 'worker-2', accepted_rate_cents: 400 });
    await recordSettlement('worker-1', [String(a.id)], 'admin-1', { method: 'cash' });

    const summaries = await listPayoutSummaries();
    const one = summaries.find((s) => s.workerId === 'worker-1');
    const two = summaries.find((s) => s.workerId === 'worker-2');
    expect(one).toMatchObject({ earnedCents: 250, settledCents: 250, unpaidCents: 0, payableCount: 0 });
    expect(two).toMatchObject({ earnedCents: 400, settledCents: 0, unpaidCents: 400, payableCount: 1 });
  });
});
