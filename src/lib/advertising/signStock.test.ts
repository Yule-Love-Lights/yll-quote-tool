// Phase-2 sign stock: MANUAL reconciliation (Naldo's ruling — no
// auto-decrement; the office counts the pile and types the number). What
// these tests pin: the counts that sit beside the number come from real
// non-test yard-sign placements only, the adjust refuses garbage, and every
// adjust writes an audit row carrying prior and new.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type AnyRow = Record<string, unknown>;

const { dbRef, stateRef, upsertOnHand, logAdvertisingActivity } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  stateRef: {
    current: {
      onHand: { sku: 'YLL-YARD-SIGN', on_hand_qty: 40, reorder_point: 10, storage_location: null } as AnyRow | null,
      // REAL ROWS, not canned totals (ledger row 482): the counts here are
      // derived by applying the query's own filters, so a filter that is
      // removed changes the answer. Canned numbers keyed on status made the
      // voided_at filter structurally invisible, which is what let it ship
      // with nothing asserting it.
      placements: [] as AnyRow[],
    },
  },
  upsertOnHand: vi.fn(),
  logAdvertisingActivity: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => dbRef.current,
}));
vi.mock('@/lib/inventory/onHand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inventory/onHand')>();
  return { ...actual, upsertOnHand };
});
vi.mock('@/lib/advertising/activity', () => ({ logAdvertisingActivity }));

function makeDb() {
  return {
    from(table: string) {
      return {
        update(payload: AnyRow) {
          const filters: Record<string, unknown> = {};
          const ub = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return ub;
            },
            select(_cols?: string) {
              return {
                maybeSingle: () => {
                  const row = stateRef.current.onHand;
                  if (
                    table !== 'inventory_on_hand' ||
                    !row ||
                    Object.entries(filters).some(([k, v]) => row[k] !== v)
                  ) {
                    return Promise.resolve({ data: null, error: null });
                  }
                  Object.assign(row, payload);
                  return Promise.resolve({ data: { sku: row.sku }, error: null });
                },
              };
            },
          };
          return ub;
        },
        select(_cols?: string, opts?: { count?: string; head?: boolean }) {
          const filters: Record<string, unknown> = {};
          const b = {
            eq(col: string, val: unknown) {
              filters[col] = val;
              return b;
            },
            is(col: string, val: unknown) {
              filters[`is:${col}`] = val;
              return b;
            },
            in(col: string, vals: unknown[]) {
              filters[col] = vals;
              return b;
            },
            maybeSingle() {
              if (table === 'inventory_on_hand') {
                return Promise.resolve({ data: stateRef.current.onHand, error: null });
              }
              return Promise.resolve({ data: null, error: null });
            },
            then(
              resolve: (v: { count: number | null; error: null }) => void,
              reject?: (e: unknown) => void,
            ) {
              // Count queries (head:true) resolve here.
              if (table !== 'advertising_placements' || !opts?.head) {
                return Promise.resolve({ count: null, error: null }).then(resolve, reject);
              }
              const count = stateRef.current.placements.filter((row) =>
                Object.entries(filters).every(([key, want]) => {
                  if (key.startsWith('is:')) {
                    const col = key.slice(3);
                    return want === null ? row[col] == null : row[col] === want;
                  }
                  const have = row[key];
                  return Array.isArray(want) ? want.includes(have) : have === want;
                }),
              ).length;
              return Promise.resolve({ count, error: null }).then(resolve, reject);
            },
          };
          return b;
        },
      };
    },
  };
}

/** A real yard-sign placement row, live and non-test unless told otherwise. */
function row(over: AnyRow = {}): AnyRow {
  return { id: 'x', kind: 'yard_sign', is_test: false, status: 'accepted', voided_at: null, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  stateRef.current.onHand = { sku: 'YLL-YARD-SIGN', on_hand_qty: 40, reorder_point: 10, storage_location: null };
  // 12 accepted and 3 pending, the same totals the canned counts used to
  // hand back, but now as rows the query has to filter for itself.
  stateRef.current.placements = [
    ...Array.from({ length: 12 }, (_, i) => row({ id: `a${i}`, status: 'accepted' })),
    ...Array.from({ length: 3 }, (_, i) => row({ id: `p${i}`, status: 'pending' })),
  ];
  dbRef.current = makeDb();
  upsertOnHand.mockResolvedValue(undefined);
});

describe('getSignStock', () => {
  it('returns the stock row beside the real placement counts', async () => {
    const { getSignStock } = await import('./signStock');
    const stock = await getSignStock();
    expect(stock).toEqual({
      onHandQty: 40,
      reorderPoint: 10,
      acceptedAllTime: 12,
      pendingReview: 3,
    });
  });

  // Ledger row 482: this filter shipped in S80 with nothing able to assert it,
  // because the old fixture handed back canned totals keyed on status and
  // stubbed is() as a pass-through. Remove the filter from signStock.ts and
  // this test fails; that is the whole point of it.
  it('leaves voided placements out of both counts', async () => {
    const { getSignStock } = await import('./signStock');
    stateRef.current.placements.push(
      row({ id: 'v1', status: 'accepted', voided_at: '2026-08-31T10:00:00.000Z' }),
      row({ id: 'v2', status: 'accepted', voided_at: '2026-08-31T11:00:00.000Z' }),
      row({ id: 'v3', status: 'pending', voided_at: '2026-08-31T12:00:00.000Z' }),
    );

    const stock = await getSignStock();

    // A voided sign is not stock that went out and not work awaiting review.
    expect(stock.acceptedAllTime).toBe(12);
    expect(stock.pendingReview).toBe(3);
  });

  it('still leaves out test rows and other kinds', async () => {
    const { getSignStock } = await import('./signStock');
    stateRef.current.placements.push(
      row({ id: 't1', is_test: true }),
      row({ id: 'd1', kind: 'door_hanger' }),
    );

    const stock = await getSignStock();
    expect(stock.acceptedAllTime).toBe(12);
  });

  it('a missing stock row reads as zero, not an error', async () => {
    const { getSignStock } = await import('./signStock');
    stateRef.current.onHand = null;
    const stock = await getSignStock();
    expect(stock.onHandQty).toBe(0);
  });
});

describe('setSignStockQty', () => {
  it('writes the new count via a CAS on the prior and audits prior and new', async () => {
    const { setSignStockQty } = await import('./signStock');
    await setSignStockQty(55, 'admin-1');
    expect(stateRef.current.onHand?.on_hand_qty).toBe(55);
    expect(logAdvertisingActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'admin-1',
        action: 'sign_stock_adjusted',
        detail: expect.objectContaining({ priorQty: 40, newQty: 55 }),
      }),
    );
  });

  it('a lost race throws instead of logging a stale prior, and the other write survives', async () => {
    const { setSignStockQty, SignStockConflictError } = await import('./signStock');
    // Another admin's count (40 -> 44) lands between this caller's read and
    // write: the mock CAS matches on on_hand_qty, so drift the row after
    // getSignStock has read it by intercepting the first read.
    const original = stateRef.current.onHand!;
    let firstRead = true;
    const realDb = dbRef.current as { from: (t: string) => unknown };
    dbRef.current = {
      from(table: string) {
        const inner = realDb.from(table) as Record<string, unknown>;
        if (table !== 'inventory_on_hand' || !firstRead) return inner;
        return {
          ...inner,
          select: (..._args: unknown[]) => ({
            eq: () => ({
              maybeSingle: () => {
                firstRead = false;
                const stale = { ...original, on_hand_qty: 40 };
                original.on_hand_qty = 44; // the concurrent write
                return Promise.resolve({ data: stale, error: null });
              },
            }),
          }),
        };
      },
    };

    await expect(setSignStockQty(55, 'admin-1')).rejects.toThrow(SignStockConflictError);
    expect(original.on_hand_qty).toBe(44); // the other admin's count survives
    expect(logAdvertisingActivity).not.toHaveBeenCalled();
  });

  it('a delete landing BETWEEN the read and the write still audits an honest prior of 0, flagged as recreated', async () => {
    const { setSignStockQty } = await import('./signStock');
    // Read sees 40; an operator deletes the row on /inventory/stock before
    // the CAS lands. Logging 40 -> 25 would hide the delete entirely
    // (delta-verify MED on this PR's own fix round).
    const original = stateRef.current.onHand!;
    let firstRead = true;
    const realDb = dbRef.current as { from: (t: string) => unknown };
    dbRef.current = {
      from(table: string) {
        const inner = realDb.from(table) as Record<string, unknown>;
        if (table !== 'inventory_on_hand' || !firstRead) return inner;
        return {
          ...inner,
          select: (..._args: unknown[]) => ({
            eq: () => ({
              maybeSingle: () => {
                firstRead = false;
                const seen = { ...original };
                stateRef.current.onHand = null; // the concurrent delete
                return Promise.resolve({ data: seen, error: null });
              },
            }),
          }),
        };
      },
    };

    await setSignStockQty(25, 'admin-1');
    expect(logAdvertisingActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ priorQty: 0, newQty: 25, recreated: true }),
      }),
    );
  });

  it('recreates the row when it was deleted on the stock page, with an honest prior of 0', async () => {
    const { setSignStockQty, YARD_SIGN_SKU } = await import('./signStock');
    stateRef.current.onHand = null;
    await setSignStockQty(25, 'admin-1');
    expect(upsertOnHand).toHaveBeenCalledWith({ sku: YARD_SIGN_SKU, on_hand_qty: 25 });
    expect(logAdvertisingActivity).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ priorQty: 0, newQty: 25 }) }),
    );
  });

  it('refuses a negative or fractional count before writing anything', async () => {
    const { setSignStockQty } = await import('./signStock');
    await expect(setSignStockQty(-1, 'admin-1')).rejects.toThrow(/count/i);
    await expect(setSignStockQty(12.5, 'admin-1')).rejects.toThrow(/count/i);
    expect(upsertOnHand).not.toHaveBeenCalled();
    expect(logAdvertisingActivity).not.toHaveBeenCalled();
  });

  it('a failed write logs nothing — the audit trail never claims a change that did not land', async () => {
    const { setSignStockQty } = await import('./signStock');
    stateRef.current.onHand = null; // recreate path, whose write is upsertOnHand
    upsertOnHand.mockRejectedValue(new Error('write failed'));
    await expect(setSignStockQty(55, 'admin-1')).rejects.toThrow();
    expect(logAdvertisingActivity).not.toHaveBeenCalled();
  });
});
