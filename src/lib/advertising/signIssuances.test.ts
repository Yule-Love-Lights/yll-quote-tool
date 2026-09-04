// Sign allotments (Naldo 2026-08-29): "I'll give a team member 50 per week,
// and that's how we know how many they have... every time they take a photo,
// we take it out of the stock we give them." Remaining is DERIVED: signs
// issued minus yard-sign photos taken (any status — a placed sign is a used
// sign, and a resubmission is the same sign, not a new one). Door hangers
// never draw the sign allotment down. Issuing also draws the warehouse pile
// down (the signs physically leave the garage), floored at zero, audited
// with prior and new.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type AnyRow = Record<string, unknown>;

const { dbRef, stateRef, logAdvertisingActivity, getAdvertisingWorker } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  stateRef: {
    current: {
      issuances: [] as AnyRow[],
      // Keyed by workerId AND kind: keyed by worker alone, the fixture
      // could not see the kind filter at all, so a balance that counted the
      // wrong kind's photos passed every test.
      placementCounts: {} as Record<string, number>, // `${workerId}:${kind}` -> count
      onHand: { sku: 'YLL-YARD-SIGN', on_hand_qty: 100 } as AnyRow | null,
      // When set, the NEXT on-hand read returns this snapshot then clears —
      // models a stale read racing a concurrent stock writer.
      staleOnHandReadOnce: null as AnyRow | null,
      // What the balance query actually ASKED the database for. Row 479 is
      // about a filter being ABSENT, and an absent filter is only testable if
      // the mock records what it was asked.
      lastPlacementFilters: {} as Record<string, unknown>,
    },
  },
  logAdvertisingActivity: vi.fn(),
  getAdvertisingWorker: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => dbRef.current }));
vi.mock('@/lib/advertising/activity', () => ({ logAdvertisingActivity }));
vi.mock('@/lib/advertising/workers', () => ({ getAdvertisingWorker }));

function makeDb() {
  return {
    from(table: string) {
      return {
        insert(payload: AnyRow) {
          if (table === 'advertising_sign_issuances') {
            // The partial unique index on request_id (ledger row 480). A mock
            // that cannot refuse a duplicate key cannot test the one thing
            // the index is there for.
            const key = payload.request_id;
            if (key != null && stateRef.current.issuances.some((r) => r.request_id === key)) {
              return {
                select: () => ({
                  maybeSingle: () => Promise.resolve({
                    data: null,
                    error: {
                      code: '23505',
                      message: 'duplicate key value violates unique constraint "advertising_sign_issuances_request_key"',
                    },
                  }),
                }),
              };
            }
            const row = {
              id: `iss-${stateRef.current.issuances.length + 1}`,
              created_at: new Date().toISOString(),
              // The column default: a row that does not name a kind is a
              // sign hand-out, which is what every pre-2026-09-04 row was.
              kind: 'yard_sign',
              ...payload,
            };
            stateRef.current.issuances.push(row);
            return {
              select: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }),
            };
          }
          return { select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'unexpected table' } }) }) };
        },
        update(payload: AnyRow) {
          const filters: Record<string, unknown> = {};
          const ub = {
            eq(col: string, val: unknown) { filters[col] = val; return ub; },
            select() {
              return {
                maybeSingle: () => {
                  const row = stateRef.current.onHand;
                  if (table !== 'inventory_on_hand' || !row || Object.entries(filters).some(([k, v]) => row[k] !== v)) {
                    return Promise.resolve({ data: null, error: null });
                  }
                  Object.assign(row, payload);
                  return Promise.resolve({ data: { sku: row.sku, on_hand_qty: row.on_hand_qty }, error: null });
                },
              };
            },
          };
          return ub;
        },
        select(_cols?: string, opts?: { count?: string; head?: boolean }) {
          const filters: Record<string, unknown> = {};
          const b = {
            eq(col: string, val: unknown) { filters[col] = val; return b; },
            // Row 479 (Naldo 2026-08-31): the balance no longer filters on
            // voided_at at all, so a stub here would hide a re-added filter.
            // Kept as a recorded no-op with a test below that fails if the
            // filter comes back.
            is(col: string, _val: unknown) { filters[`is:${col}`] = true; return b; },
            maybeSingle() {
              if (table === 'inventory_on_hand') {
                if (stateRef.current.staleOnHandReadOnce) {
                  const stale = stateRef.current.staleOnHandReadOnce;
                  stateRef.current.staleOnHandReadOnce = null;
                  return Promise.resolve({ data: stale, error: null });
                }
                return Promise.resolve({ data: stateRef.current.onHand, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            },
            order() {
              return {
                range: () => Promise.resolve({
                  data: stateRef.current.issuances.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v)),
                  error: null,
                }),
              };
            },
            // An ARRAY read, used where two matches are possible and
            // maybeSingle would answer with an error instead of a row.
            limit(n: number) {
              const hits = stateRef.current.issuances.filter((r) =>
                Object.entries(filters).every(([k, v]) => r[k] === v),
              );
              return Promise.resolve({ data: hits.slice(0, n), error: null });
            },
            then(resolve: (v: { count: number | null; error: null }) => void, reject?: (e: unknown) => void) {
              if (table === 'advertising_placements' && opts?.head) {
                stateRef.current.lastPlacementFilters = { ...filters };
                const workerId = String(filters.worker_id ?? '');
                const askedKind = String(filters.kind ?? 'yard_sign');
                const key = `${workerId}:${askedKind}`;
                return Promise.resolve({
                  count: stateRef.current.placementCounts[key] ?? 0,
                  error: null,
                }).then(resolve, reject);
              }
              if (table === 'advertising_sign_issuances' && opts?.head) {
                return Promise.resolve({ count: null, error: null }).then(resolve, reject);
              }
              return Promise.resolve({ count: null, error: null }).then(resolve, reject);
            },
          };
          return b;
        },
      };
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stateRef.current.issuances = [];
  stateRef.current.placementCounts = {};
  stateRef.current.onHand = { sku: 'YLL-YARD-SIGN', on_hand_qty: 100 };
  stateRef.current.staleOnHandReadOnce = null;
  stateRef.current.lastPlacementFilters = {};
  dbRef.current = makeDb();
  getAdvertisingWorker.mockResolvedValue({
    id: 'worker-1', displayName: 'Joe Signs', authUserId: null, active: true, isTest: false,
    createdAt: 'x', updatedAt: 'x',
  });
});

describe('door hangers get their own allotment (Naldo 2026-09-04)', () => {
  it('keeps the two ledgers apart, so hangers never eat the sign balance', async () => {
    const { issueSigns, getWorkerSignBalance } = await import('./signIssuances');
    await issueSigns('worker-1', 50, 'admin-1', undefined, undefined, 'yard_sign');
    await issueSigns('worker-1', 300, 'admin-1', undefined, undefined, 'door_hanger');

    // DIFFERENT counts per kind, so a balance counting the wrong kind's
    // photos shows up rather than hiding behind one shared number.
    stateRef.current.placementCounts['worker-1:yard_sign'] = 3;
    stateRef.current.placementCounts['worker-1:door_hanger'] = 10;

    const signs = await getWorkerSignBalance('worker-1', 'yard_sign');
    expect(signs.issuedTotal).toBe(50);
    expect(signs.signsUsed).toBe(3);
    expect(signs.remaining).toBe(47);

    const hangers = await getWorkerSignBalance('worker-1', 'door_hanger');
    expect(hangers.issuedTotal).toBe(300);
    // 10, not 3: a balance that counted the other kind's photos would read 3
    // here, which is exactly the bug this asserts against.
    expect(hangers.signsUsed).toBe(10);
    expect(hangers.remaining).toBe(290);
  });

  it('defaults to signs, so every hand-out written before today still reads true', async () => {
    const { issueSigns, getWorkerSignBalance } = await import('./signIssuances');
    await issueSigns('worker-1', 25, 'admin-1');
    const balance = await getWorkerSignBalance('worker-1');
    expect(balance.kind).toBe('yard_sign');
    expect(balance.issuedTotal).toBe(25);
    expect((await getWorkerSignBalance('worker-1', 'door_hanger')).issuedTotal).toBe(0);
  });

  it('does NOT draw the warehouse down for door hangers', async () => {
    const { issueSigns } = await import('./signIssuances');
    const before = stateRef.current.onHand?.on_hand_qty;

    await issueSigns('worker-1', 200, 'admin-1', undefined, undefined, 'door_hanger');

    // inventory_on_hand is the yard-sign SKU. Hangers have no SKU, so taking
    // 200 of them must not remove 200 signs from the garage.
    expect(stateRef.current.onHand?.on_hand_qty).toBe(before);
  });

  it('still draws the warehouse down for signs', async () => {
    const { issueSigns } = await import('./signIssuances');
    await issueSigns('worker-1', 10, 'admin-1', undefined, undefined, 'yard_sign');
    expect(stateRef.current.onHand?.on_hand_qty).toBe(90);
  });

  it('records which kind was handed over in the trail', async () => {
    const { issueSigns } = await import('./signIssuances');
    await issueSigns('worker-1', 40, 'admin-1', undefined, undefined, 'door_hanger');
    expect(logAdvertisingActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'signs_issued', detail: expect.objectContaining({ kind: 'door_hanger', qty: 40 }) }),
    );
  });

  it('refuses an unknown kind', async () => {
    const { issueSigns } = await import('./signIssuances');
    await expect(
      issueSigns('worker-1', 10, 'admin-1', undefined, undefined, 'stickers' as never),
    ).rejects.toThrow(/kind/i);
  });
});

describe('row 480: a double-submitted hand-out lands once', () => {
  // The old guard read the worker's latest row and compared qty and admin
  // inside a 15-second window. Two genuinely simultaneous submits both read
  // an empty window and both inserted, doubling the ledger and drawing the
  // warehouse twice for one physical stack. The screen now mints one id per
  // confirmed hand-out, so a retry of that click carries the same id.
  it('records ONE issuance when the same request arrives twice', async () => {
    const { issueSigns } = await import('./signIssuances');
    const requestId = '11111111-1111-4111-8111-111111111111';

    const [a, b] = await Promise.all([
      issueSigns('worker-1', 50, 'admin-1', undefined, requestId),
      issueSigns('worker-1', 50, 'admin-1', undefined, requestId),
    ]);

    expect(stateRef.current.issuances).toHaveLength(1);
    // Both callers get the hand-out that actually landed, not an error.
    expect(a.issuance.id).toBe(b.issuance.id);
    expect(a.issuedQty).toBe(50);
    expect(b.issuedQty).toBe(50);
  });

  it('lets two REAL hand-outs through, even when they look identical', async () => {
    const { issueSigns } = await import('./signIssuances');
    await issueSigns('worker-1', 50, 'admin-1', undefined, '22222222-2222-4222-8222-222222222222');
    await issueSigns('worker-1', 50, 'admin-1', undefined, '33333333-3333-4333-8333-333333333333');

    // Same worker, same qty, same admin, seconds apart: the old time window
    // would have swallowed the second one.
    expect(stateRef.current.issuances).toHaveLength(2);
  });

  it('draws the warehouse down once for a repeated request', async () => {
    const { issueSigns } = await import('./signIssuances');
    const requestId = '44444444-4444-4444-8444-444444444444';
    await issueSigns('worker-1', 10, 'admin-1', undefined, requestId);
    await issueSigns('worker-1', 10, 'admin-1', undefined, requestId);

    // One physical stack left the garage, so the pile moves once.
    expect(stateRef.current.onHand?.on_hand_qty).toBe(90);
  });

  it('still falls back to the time window when no id is sent', async () => {
    const { issueSigns } = await import('./signIssuances');
    await issueSigns('worker-1', 50, 'admin-1');
    await issueSigns('worker-1', 50, 'admin-1');
    expect(stateRef.current.issuances).toHaveLength(1);
  });
});

describe('row 479: a placed sign is a used sign', () => {
  // Naldo's ruling, 2026-08-31. Voiding a yard-sign photo no longer returns
  // a sign to the allotment: the plastic is in the ground whatever happens
  // to the photo or the pay. KNOWN AND ACCEPTED: a voided photo that is
  // re-uploaded counts twice, because it becomes a second placement row.
  it('does not ask the database to exclude voided rows', async () => {
    const { getWorkerSignBalance } = await import('./signIssuances');
    stateRef.current.issuances = [
      { id: 'i1', worker_id: 'worker-1', qty: 50, issued_by: 'admin-1', note: null, created_at: 'x', kind: 'yard_sign' },
    ];
    stateRef.current.placementCounts['worker-1:yard_sign'] = 3;

    const balance = await getWorkerSignBalance('worker-1');
    expect(balance.signsUsed).toBe(3);
    expect(balance.remaining).toBe(47);
    // The filter is the thing under test: if a voided_at filter is re-added,
    // this fails, because voided signs must keep counting.
    expect(stateRef.current.lastPlacementFilters['is:voided_at']).toBeUndefined();
    // Control: the recorder DOES capture what this query sets, so the
    // assertion above is about the code and not a broken instrument.
    expect(stateRef.current.lastPlacementFilters.kind).toBe('yard_sign');
    expect(stateRef.current.lastPlacementFilters.worker_id).toBe('worker-1');
  });
});

describe('issueSigns', () => {
  it('records the issuance, draws the warehouse down, and audits prior/new with the admin', async () => {
    const { issueSigns } = await import('./signIssuances');
    const result = await issueSigns('worker-1', 50, 'admin-1');
    expect(result.issuedQty).toBe(50);
    expect(stateRef.current.onHand?.on_hand_qty).toBe(50);
    expect(stateRef.current.issuances).toHaveLength(1);
    expect(logAdvertisingActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'admin-1',
        action: 'signs_issued',
        workerId: 'worker-1',
        detail: expect.objectContaining({ qty: 50, warehousePrior: 100, warehouseNew: 50, warehouseUpdated: true }),
      }),
    );
  });

  it('floors the warehouse at zero when issuing more than the counted pile (the count is manual and can be stale)', async () => {
    const { issueSigns } = await import('./signIssuances');
    stateRef.current.onHand = { sku: 'YLL-YARD-SIGN', on_hand_qty: 30 };
    await issueSigns('worker-1', 50, 'admin-1');
    expect(stateRef.current.onHand?.on_hand_qty).toBe(0);
    expect(logAdvertisingActivity).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ warehousePrior: 30, warehouseNew: 0 }) }),
    );
  });

  it('a lost warehouse race retries against the fresh count and audits the TRUE numbers', async () => {
    const { issueSigns } = await import('./signIssuances');
    // This caller's first read sees 100, but a concurrent stock edit moved
    // the row to 80 before the CAS lands. The retry re-reads and succeeds.
    stateRef.current.onHand = { sku: 'YLL-YARD-SIGN', on_hand_qty: 80 };
    stateRef.current.staleOnHandReadOnce = { sku: 'YLL-YARD-SIGN', on_hand_qty: 100 };

    await issueSigns('worker-1', 50, 'admin-1');
    expect(stateRef.current.onHand?.on_hand_qty).toBe(30);
    expect(logAdvertisingActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ warehousePrior: 80, warehouseNew: 30, warehouseUpdated: true }),
      }),
    );
  });

  it('when the warehouse write never lands, the audit says so instead of claiming numbers', async () => {
    const { issueSigns } = await import('./signIssuances');
    // Every read is stale (the row drifts continuously) so every CAS misses.
    const db = dbRef.current as { from: (t: string) => Record<string, unknown> };
    let flips = 0;
    dbRef.current = {
      from(table: string) {
        if (table === 'inventory_on_hand') {
          stateRef.current.staleOnHandReadOnce = { sku: 'YLL-YARD-SIGN', on_hand_qty: 100 + ++flips };
        }
        return db.from(table);
      },
    };

    await issueSigns('worker-1', 50, 'admin-1');
    expect(stateRef.current.issuances).toHaveLength(1); // the hand-out still stands
    expect(logAdvertisingActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ warehouseUpdated: false }),
      }),
    );
    const detail = logAdvertisingActivity.mock.calls[0][0].detail as Record<string, unknown>;
    expect(detail.warehouseNew).toBeUndefined(); // no claimed transition
  });

  it('issuing to a TEST worker never touches the real warehouse pile', async () => {
    const { issueSigns } = await import('./signIssuances');
    getAdvertisingWorker.mockResolvedValue({
      id: 'worker-1', displayName: 'E2E Test Worker', authUserId: null, active: true, isTest: true,
      createdAt: 'x', updatedAt: 'x',
    });
    await issueSigns('worker-1', 50, 'admin-1');
    expect(stateRef.current.onHand?.on_hand_qty).toBe(100);
    expect(logAdvertisingActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ testWorker: true, warehouseUpdated: false }),
      }),
    );
  });

  it('an identical double-submit inside the retry window returns the FIRST issuance instead of doubling', async () => {
    const { issueSigns } = await import('./signIssuances');
    const first = await issueSigns('worker-1', 50, 'admin-1');
    const second = await issueSigns('worker-1', 50, 'admin-1');
    expect(stateRef.current.issuances).toHaveLength(1);
    expect(second.issuance.id).toBe(first.issuance.id);
    expect(stateRef.current.onHand?.on_hand_qty).toBe(50); // drawn once
  });

  it('the dedup window is scoped to the SAME admin — a second admin handing out the same qty records its own row', async () => {
    const { issueSigns } = await import('./signIssuances');
    await issueSigns('worker-1', 50, 'admin-1');
    await issueSigns('worker-1', 50, 'admin-2'); // a real second hand-out
    expect(stateRef.current.issuances).toHaveLength(2);
  });

  it('refuses an unknown worker before writing anything', async () => {
    const { issueSigns } = await import('./signIssuances');
    getAdvertisingWorker.mockResolvedValue(null);
    await expect(issueSigns('worker-ghost', 50, 'admin-1')).rejects.toThrow(/worker/i);
    expect(stateRef.current.issuances).toHaveLength(0);
  });

  it('refuses zero, negative, and fractional quantities without writing anything', async () => {
    const { issueSigns } = await import('./signIssuances');
    for (const bad of [0, -5, 12.5]) {
      await expect(issueSigns('worker-1', bad, 'admin-1')).rejects.toThrow(/quantity/i);
    }
    expect(stateRef.current.issuances).toHaveLength(0);
    expect(stateRef.current.onHand?.on_hand_qty).toBe(100);
    expect(logAdvertisingActivity).not.toHaveBeenCalled();
  });
});

describe('getWorkerSignBalance', () => {
  it('remaining = issued minus yard-sign photos taken (any status)', async () => {
    const { issueSigns, getWorkerSignBalance } = await import('./signIssuances');
    await issueSigns('worker-1', 50, 'admin-1');
    await issueSigns('worker-1', 20, 'admin-1');
    stateRef.current.placementCounts['worker-1:yard_sign'] = 12;

    const balance = await getWorkerSignBalance('worker-1');
    expect(balance).toEqual({ workerId: 'worker-1',
      kind: 'yard_sign', issuedTotal: 70, signsUsed: 12, remaining: 58 });
  });

  it('a worker who was never issued anything reads as zeros, and overuse clamps remaining at 0', async () => {
    const { getWorkerSignBalance, issueSigns } = await import('./signIssuances');
    expect(await getWorkerSignBalance('worker-9')).toEqual({
      workerId: 'worker-9',
      kind: 'yard_sign', issuedTotal: 0, signsUsed: 0, remaining: 0,
    });
    await issueSigns('worker-1', 10, 'admin-1');
    stateRef.current.placementCounts['worker-1:yard_sign'] = 14; // used more than issued (pre-tracking history)
    const balance = await getWorkerSignBalance('worker-1');
    expect(balance.remaining).toBe(0);
    expect(balance.signsUsed).toBe(14);
  });
});
