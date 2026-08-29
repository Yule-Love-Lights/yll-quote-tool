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
      counts: { accepted: 12, pending: 3 },
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
        select(_cols?: string, opts?: { count?: string; head?: boolean }) {
          const filters: Record<string, unknown> = {};
          const b = {
            eq(col: string, val: unknown) {
              filters[col] = val;
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
              const status = filters.status;
              const count = status === 'accepted'
                ? stateRef.current.counts.accepted
                : stateRef.current.counts.pending;
              return Promise.resolve({ count, error: null }).then(resolve, reject);
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
  stateRef.current.onHand = { sku: 'YLL-YARD-SIGN', on_hand_qty: 40, reorder_point: 10, storage_location: null };
  stateRef.current.counts = { accepted: 12, pending: 3 };
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

  it('a missing stock row reads as zero, not an error', async () => {
    const { getSignStock } = await import('./signStock');
    stateRef.current.onHand = null;
    const stock = await getSignStock();
    expect(stock.onHandQty).toBe(0);
  });
});

describe('setSignStockQty', () => {
  it('writes the new count and audits prior and new with the acting admin', async () => {
    const { setSignStockQty, YARD_SIGN_SKU } = await import('./signStock');
    await setSignStockQty(55, 'admin-1');
    expect(upsertOnHand).toHaveBeenCalledWith({ sku: YARD_SIGN_SKU, on_hand_qty: 55 });
    expect(logAdvertisingActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'admin-1',
        action: 'sign_stock_adjusted',
        detail: expect.objectContaining({ priorQty: 40, newQty: 55 }),
      }),
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
    upsertOnHand.mockRejectedValue(new Error('write failed'));
    await expect(setSignStockQty(55, 'admin-1')).rejects.toThrow();
    expect(logAdvertisingActivity).not.toHaveBeenCalled();
  });
});
