// On-order ledger (P8, folds in #110 W7-002). The supabase client is mocked with
// a chainable fake (mirrors jobsPrepare.test.ts's makeDb convention) so the
// atomic-claim + on-hand-increment logic in receiveOrder/cancelOrder runs for
// real against a scripted DB.

import { describe, it, expect, beforeEach, vi } from 'vitest';

let currentDb: unknown = null;

const { upsertOnHand, listOnHand } = vi.hoisted(() => ({
  upsertOnHand: vi.fn(async () => {}),
  listOnHand: vi.fn(async () => [] as { sku: string; on_hand_qty: number; reorder_point: number; storage_location: string | null }[]),
}));

vi.mock('../supabase', () => ({ getSupabaseServiceClient: () => currentDb }));
vi.mock('./onHand', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./onHand')>()),
  listOnHand,
  upsertOnHand,
}));

import { listOrders, sumOpenOnOrder, recordOrder, markOrderSent, cancelOrder, receiveOrder } from './orders';

type Row = {
  id: string;
  created_at: string;
  sent_at: string | null;
  channel: 'manual' | 'auto-cron' | 'auto-webhook';
  status: 'open' | 'received' | 'cancelled';
  received_at: string | null;
  lines: unknown;
  received_lines: unknown;
  job_count: number;
};

// A db fake that supports: select().order() (list), select().eq().order()
// (status filter), insert().select().single() (recordOrder), update().eq()
// (markOrderSent), and update().eq().eq().select().maybeSingle() (the atomic
// claims in cancelOrder / receiveOrder). Also select().eq().maybeSingle() for
// the pre-read in receiveOrder.
function makeDb(opts: {
  rows?: Row[];
  insertOk?: boolean;
  claimWins?: boolean;
} = {}) {
  const rows = opts.rows ?? [];
  const insertOk = opts.insertOk ?? true;
  const claimWins = opts.claimWins ?? true;

  return {
    from(table: string) {
      if (table !== 'inventory_orders') throw new Error(`unexpected table ${table}`);
      const state: { op: 'select' | 'insert' | 'update'; filters: Record<string, unknown>; payload?: Record<string, unknown> } = {
        op: 'select',
        filters: {},
      };
      const b = {
        insert(payload: Record<string, unknown>) {
          state.op = 'insert';
          state.payload = payload;
          return b;
        },
        update(payload: Record<string, unknown>) {
          state.op = 'update';
          state.payload = payload;
          return b;
        },
        select() {
          return b;
        },
        eq(col: string, val: unknown) {
          state.filters[col] = val;
          return b;
        },
        order() {
          return b;
        },
        async then(resolve: (v: { data: unknown; error: unknown }) => void) {
          // Plain select (listOrders) resolved via await, not .single()/.maybeSingle().
          let out = rows;
          if (state.filters.status !== undefined) out = out.filter((r) => r.status === state.filters.status);
          resolve({ data: out, error: null });
        },
        async single() {
          if (state.op === 'insert') {
            if (!insertOk) return { data: null, error: { message: 'insert failed' } };
            const id = 'new-id';
            rows.push({
              id,
              created_at: new Date().toISOString(),
              sent_at: null,
              channel: (state.payload?.channel as Row['channel']) ?? 'manual',
              status: 'open',
              received_at: null,
              lines: state.payload?.lines ?? [],
              received_lines: null,
              job_count: (state.payload?.job_count as number) ?? 0,
            });
            return { data: { id }, error: null };
          }
          return { data: null, error: { message: 'unsupported .single()' } };
        },
        async maybeSingle() {
          const id = state.filters.id as string | undefined;
          const row = rows.find((r) => r.id === id);
          if (state.op === 'update') {
            // Atomic conditional claim — only succeeds if the row exists AND
            // matches the extra eq('status', 'open') filter already recorded.
            if (!row) return { data: null, error: null };
            const wantsOpen = state.filters.status === 'open';
            if (wantsOpen && row.status !== 'open') return { data: null, error: null };
            if (!claimWins) return { data: null, error: null };
            Object.assign(row, state.payload);
            return { data: { id: row.id }, error: null };
          }
          // Plain read-before-claim.
          if (!row) return { data: null, error: null };
          return { data: row, error: null };
        },
      };
      return b;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentDb = makeDb();
});

describe('sumOpenOnOrder', () => {
  it('sums qty per SKU across multiple open orders, skips received/cancelled and junk values', async () => {
    currentDb = makeDb({
      rows: [
        { id: 'o1', created_at: '', sent_at: null, channel: 'manual', status: 'open', received_at: null, lines: [{ sku: 'A', name: 'A', qty: 5 }, { sku: 'B', name: 'B', qty: 2 }], received_lines: null, job_count: 1 },
        { id: 'o2', created_at: '', sent_at: null, channel: 'manual', status: 'open', received_at: null, lines: [{ sku: 'A', name: 'A', qty: 3 }, { sku: 'C', name: 'C', qty: -5 }], received_lines: null, job_count: 1 },
        { id: 'o3', created_at: '', sent_at: null, channel: 'manual', status: 'received', received_at: '', lines: [{ sku: 'A', name: 'A', qty: 99 }], received_lines: [{ sku: 'A', qty: 99 }], job_count: 1 },
        { id: 'o4', created_at: '', sent_at: null, channel: 'manual', status: 'cancelled', received_at: null, lines: [{ sku: 'A', name: 'A', qty: 99 }], received_lines: null, job_count: 1 },
        { id: 'o5', created_at: '', sent_at: null, channel: 'manual', status: 'open', received_at: null, lines: [{ sku: 'B', name: 'B', qty: Number.NaN }], received_lines: null, job_count: 1 },
      ],
    });
    const sums = await sumOpenOnOrder();
    expect(sums.get('A')).toBe(8); // 5 + 3, o3/o4 excluded (not open)
    expect(sums.get('B')).toBe(2); // 2 + NaN(→0)
    expect(sums.get('C')).toBe(0); // negative qty counts as 0
  });

  it('returns an empty map when there are no open orders', async () => {
    currentDb = makeDb({ rows: [] });
    const sums = await sumOpenOnOrder();
    expect(sums.size).toBe(0);
  });
});

describe('listOrders', () => {
  it('swallows read errors to []', async () => {
    currentDb = null;
    expect(await listOrders()).toEqual([]);
  });
});

describe('recordOrder', () => {
  it('returns the new row id on success', async () => {
    currentDb = makeDb({ rows: [] });
    const id = await recordOrder({ channel: 'manual', lines: [{ sku: 'A', name: 'A', qty: 5 }], jobCount: 2 });
    expect(id).toBe('new-id');
  });

  it('returns null and does not throw when the insert fails', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    currentDb = makeDb({ insertOk: false });
    const id = await recordOrder({ channel: 'manual', lines: [{ sku: 'A', name: 'A', qty: 5 }], jobCount: 2 });
    expect(id).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('returns null when Supabase is not configured', async () => {
    currentDb = null;
    const id = await recordOrder({ channel: 'manual', lines: [], jobCount: 0 });
    expect(id).toBeNull();
  });
});

describe('markOrderSent', () => {
  it('is best-effort — does not throw when Supabase is not configured', async () => {
    currentDb = null;
    await expect(markOrderSent('o1')).resolves.toBeUndefined();
  });
});

describe('cancelOrder', () => {
  const OPEN_ROW: Row = { id: 'o1', created_at: '', sent_at: null, channel: 'manual', status: 'open', received_at: null, lines: [], received_lines: null, job_count: 1 };

  it('wins the claim and returns cancelled', async () => {
    currentDb = makeDb({ rows: [{ ...OPEN_ROW }] });
    expect(await cancelOrder('o1')).toBe('cancelled');
  });

  it('returns already-closed when the row is no longer open', async () => {
    currentDb = makeDb({ rows: [{ ...OPEN_ROW, status: 'received' }] });
    expect(await cancelOrder('o1')).toBe('already-closed');
  });

  it('returns null when the order does not exist', async () => {
    currentDb = makeDb({ rows: [] });
    expect(await cancelOrder('nope')).toBeNull();
  });
});

describe('receiveOrder', () => {
  const OPEN_ROW: Row = {
    id: 'o1',
    created_at: '',
    sent_at: '2026-07-01T00:00:00Z',
    channel: 'manual',
    status: 'open',
    received_at: null,
    lines: [{ sku: 'A', name: 'Item A', qty: 10 }, { sku: 'B', name: 'Item B', qty: 4 }],
    received_lines: null,
    job_count: 2,
  };

  beforeEach(() => {
    listOnHand.mockResolvedValue([
      { sku: 'A', on_hand_qty: 5, reorder_point: 0, storage_location: null },
      { sku: 'B', on_hand_qty: 1, reorder_point: 0, storage_location: null },
    ]);
  });

  it('full receipt (no override) increments on-hand by the ordered qty', async () => {
    currentDb = makeDb({ rows: [{ ...OPEN_ROW }] });
    const res = await receiveOrder('o1');
    expect(res).toEqual({ ok: true });
    expect(upsertOnHand).toHaveBeenCalledWith({ sku: 'A', on_hand_qty: 15 });
    expect(upsertOnHand).toHaveBeenCalledWith({ sku: 'B', on_hand_qty: 5 });
  });

  it('edited (short) quantities use the edited numbers, not the ordered ones', async () => {
    currentDb = makeDb({ rows: [{ ...OPEN_ROW }] });
    const res = await receiveOrder('o1', [{ sku: 'A', qty: 6 }, { sku: 'B', qty: 4 }]);
    expect(res).toEqual({ ok: true });
    expect(upsertOnHand).toHaveBeenCalledWith({ sku: 'A', on_hand_qty: 11 }); // 5 + 6
    expect(upsertOnHand).toHaveBeenCalledWith({ sku: 'B', on_hand_qty: 5 }); // 1 + 4
  });

  it('claim loss returns alreadyDone and writes NO stock', async () => {
    currentDb = makeDb({ rows: [{ ...OPEN_ROW }], claimWins: false });
    const res = await receiveOrder('o1');
    expect(res).toEqual({ ok: true, alreadyDone: true });
    expect(upsertOnHand).not.toHaveBeenCalled();
  });

  it('order already closed (not open) returns alreadyDone without a claim attempt', async () => {
    currentDb = makeDb({ rows: [{ ...OPEN_ROW, status: 'received' }] });
    const res = await receiveOrder('o1');
    expect(res).toEqual({ ok: true, alreadyDone: true });
    expect(upsertOnHand).not.toHaveBeenCalled();
  });

  it('missing order returns null', async () => {
    currentDb = makeDb({ rows: [] });
    expect(await receiveOrder('nope')).toBeNull();
  });

  it('rejects a SKU that was never ordered', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    currentDb = makeDb({ rows: [{ ...OPEN_ROW }] });
    const res = await receiveOrder('o1', [{ sku: 'ZZZ', qty: 1 }]);
    expect(res).toBeNull();
    expect(upsertOnHand).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('one failed on-hand write does not stop the others or unwind the claim', async () => {
    upsertOnHand.mockImplementationOnce(async () => { throw new Error('boom'); });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    currentDb = makeDb({ rows: [{ ...OPEN_ROW }] });
    const res = await receiveOrder('o1');
    expect(res).toEqual({ ok: true });
    expect(upsertOnHand).toHaveBeenCalledTimes(2); // both attempted despite the first throwing
    spy.mockRestore();
  });
});
