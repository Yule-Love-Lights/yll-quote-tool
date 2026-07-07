// On-order ledger (P8, folds in #110 W7-002). The supabase client is mocked with
// a chainable fake (mirrors jobsPrepare.test.ts's makeDb convention) so the
// atomic-claim + on-hand-increment logic in receiveOrder/cancelOrder runs for
// real against a scripted DB. The inventory_on_hand fake models the updated_at
// optimistic-concurrency guard (a bumped updated_at on every write) so the
// atomic-delta increment in receiveOrder can be exercised end to end, including
// a concurrent writer landing in the read -> write gap.

import { describe, it, expect, beforeEach, vi } from 'vitest';

let currentDb: unknown = null;

vi.mock('../supabase', () => ({
  getSupabaseServiceClient: () => currentDb,
  getSupabaseClient: () => currentDb,
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

type OnHandCell = { on_hand_qty: number; updated_at: string };

// A db fake spanning two tables:
//   inventory_orders — select().order() (list), select().eq().order() (status
//   filter), insert().select().single() (recordOrder), update().eq()
//   (markOrderSent), update().eq().eq().select().maybeSingle() (the atomic
//   claims in cancelOrder / receiveOrder), and select().eq().maybeSingle() for
//   the pre-read in receiveOrder.
//   inventory_on_hand — select('on_hand_qty, updated_at').eq('sku').maybeSingle()
//   (the atomic increment read), update({on_hand_qty}).eq('sku').eq('updated_at')
//   .select('sku') (the guarded write — matches only when updated_at is
//   unchanged, and bumps updated_at on success), and upsert(...).select('sku')
//   (the new-SKU insert path). A plain select()/order() is also supported so the
//   pre-fix listOnHand read still resolves during the red run.
function makeDb(opts: {
  rows?: Row[];
  insertOk?: boolean;
  claimWins?: boolean;
  onHand?: { sku: string; on_hand_qty: number; updated_at: string }[];
  // Simulates a concurrent writer adding `addQty` to `sku` in the gap between
  // receiveOrder's read and its guarded write; fires exactly once.
  onHandConcurrentBump?: { sku: string; addQty: number };
  // SKUs whose inventory_on_hand read returns an error (to exercise the
  // "one failed write doesn't stop the others" path).
  onHandFailSkus?: string[];
} = {}) {
  const rows = opts.rows ?? [];
  const insertOk = opts.insertOk ?? true;
  const claimWins = opts.claimWins ?? true;

  const onHand = new Map<string, OnHandCell>();
  for (const r of opts.onHand ?? []) onHand.set(r.sku, { on_hand_qty: r.on_hand_qty, updated_at: r.updated_at });
  const failSkus = new Set(opts.onHandFailSkus ?? []);
  let concurrentBump = opts.onHandConcurrentBump ?? null;
  let ohVersion = 0;
  const bumpVersion = () => `oh-v${++ohVersion}`;

  const db = {
    _onHand: onHand,
    from(table: string) {
      if (table === 'inventory_orders') {
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
      }

      if (table === 'inventory_on_hand') {
        const st: { op: 'select' | 'update' | 'upsert'; filters: Record<string, unknown>; payload?: Record<string, unknown> } = {
          op: 'select',
          filters: {},
        };
        const ob = {
          select() {
            return ob;
          },
          update(payload: Record<string, unknown>) {
            st.op = 'update';
            st.payload = payload;
            return ob;
          },
          upsert(payload: Record<string, unknown>) {
            st.op = 'upsert';
            st.payload = payload;
            return ob;
          },
          insert(payload: Record<string, unknown>) {
            st.op = 'upsert';
            st.payload = payload;
            return ob;
          },
          eq(col: string, val: unknown) {
            st.filters[col] = val;
            return ob;
          },
          order() {
            return ob;
          },
          async maybeSingle() {
            const sku = st.filters.sku as string;
            if (failSkus.has(sku)) return { data: null, error: { message: 'boom' } };
            const cell = onHand.get(sku);
            if (!cell) return { data: null, error: null };
            return { data: { on_hand_qty: cell.on_hand_qty, updated_at: cell.updated_at }, error: null };
          },
          async then(resolve: (v: { data: unknown; error: unknown }) => void) {
            if (st.op === 'update') {
              const sku = st.filters.sku as string;
              // A concurrent writer lands in the read -> write gap exactly once.
              if (concurrentBump && concurrentBump.sku === sku) {
                const cur = onHand.get(sku);
                if (cur) {
                  cur.on_hand_qty += concurrentBump.addQty;
                  cur.updated_at = bumpVersion();
                }
                concurrentBump = null;
              }
              const cell = onHand.get(sku);
              // The optimistic guard: the write only lands if updated_at is
              // still the snapshot the caller read. On success, bump updated_at
              // (mirrors the inventory_on_hand before-update trigger).
              if (cell && cell.updated_at === st.filters.updated_at) {
                cell.on_hand_qty = st.payload?.on_hand_qty as number;
                cell.updated_at = bumpVersion();
                resolve({ data: [{ sku }], error: null });
              } else {
                resolve({ data: [], error: null });
              }
              return;
            }
            if (st.op === 'upsert') {
              const sku = st.payload?.sku as string;
              const existing = onHand.get(sku);
              if (existing) {
                // Pre-fix upsertOnHand did an absolute set here; the fixed code
                // only reaches the upsert branch for a genuinely-new SKU, so a
                // concurrent insert is ignored (ignoreDuplicates) and returns no
                // row, prompting a read + increment retry.
                resolve({ data: [], error: null });
              } else {
                onHand.set(sku, { on_hand_qty: st.payload?.on_hand_qty as number, updated_at: bumpVersion() });
                resolve({ data: [{ sku }], error: null });
              }
              return;
            }
            // Plain select (pre-fix listOnHand read) → every row.
            const all = [...onHand.entries()].map(([sku, cell]) => ({
              sku,
              on_hand_qty: cell.on_hand_qty,
              reorder_point: 0,
              storage_location: null,
              updated_at: cell.updated_at,
            }));
            resolve({ data: all, error: null });
          },
        };
        return ob;
      }

      throw new Error(`unexpected table ${table}`);
    },
  };
  return db;
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
  const SEED = [
    { sku: 'A', on_hand_qty: 5, updated_at: 'oh0' },
    { sku: 'B', on_hand_qty: 1, updated_at: 'oh0' },
  ];

  it('full receipt (no override) increments on-hand by the ordered qty', async () => {
    const db = makeDb({ rows: [{ ...OPEN_ROW }], onHand: SEED });
    currentDb = db;
    const res = await receiveOrder('o1');
    expect(res).toEqual({ ok: true });
    expect(db._onHand.get('A')!.on_hand_qty).toBe(15); // 5 + 10
    expect(db._onHand.get('B')!.on_hand_qty).toBe(5); // 1 + 4
  });

  it('edited (short) quantities use the edited numbers, not the ordered ones', async () => {
    const db = makeDb({ rows: [{ ...OPEN_ROW }], onHand: SEED });
    currentDb = db;
    const res = await receiveOrder('o1', [{ sku: 'A', qty: 6 }, { sku: 'B', qty: 4 }]);
    expect(res).toEqual({ ok: true });
    expect(db._onHand.get('A')!.on_hand_qty).toBe(11); // 5 + 6
    expect(db._onHand.get('B')!.on_hand_qty).toBe(5); // 1 + 4
  });

  // The core data-integrity guarantee: a concurrent receipt/decrement on the
  // same SKU landing between this receipt's read and write must NOT be clobbered.
  // The pre-fix absolute-set (read snapshot 5, write 5+10=15) silently drops the
  // concurrent +3 — phantom stock that makes the next supplier PO under-order.
  // The atomic guarded increment retries against the fresh value: 5 + 3 + 10 = 18.
  it('atomic increment retries when a concurrent writer bumps the SKU between read and write (no lost delta)', async () => {
    const db = makeDb({
      rows: [{ ...OPEN_ROW, lines: [{ sku: 'A', name: 'Item A', qty: 10 }] }],
      onHand: [{ sku: 'A', on_hand_qty: 5, updated_at: 'oh0' }],
      onHandConcurrentBump: { sku: 'A', addQty: 3 },
    });
    currentDb = db;
    const res = await receiveOrder('o1');
    expect(res).toEqual({ ok: true });
    expect(db._onHand.get('A')!.on_hand_qty).toBe(18); // 5 + 3 (concurrent) + 10
  });

  it('claim loss returns alreadyDone and writes NO stock', async () => {
    const db = makeDb({ rows: [{ ...OPEN_ROW }], claimWins: false, onHand: SEED });
    currentDb = db;
    const res = await receiveOrder('o1');
    expect(res).toEqual({ ok: true, alreadyDone: true });
    expect(db._onHand.get('A')!.on_hand_qty).toBe(5); // untouched
    expect(db._onHand.get('B')!.on_hand_qty).toBe(1);
  });

  it('order already closed (not open) returns alreadyDone without a claim attempt', async () => {
    const db = makeDb({ rows: [{ ...OPEN_ROW, status: 'received' }], onHand: SEED });
    currentDb = db;
    const res = await receiveOrder('o1');
    expect(res).toEqual({ ok: true, alreadyDone: true });
    expect(db._onHand.get('A')!.on_hand_qty).toBe(5);
    expect(db._onHand.get('B')!.on_hand_qty).toBe(1);
  });

  it('missing order returns null', async () => {
    currentDb = makeDb({ rows: [] });
    expect(await receiveOrder('nope')).toBeNull();
  });

  it('rejects a SKU that was never ordered', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = makeDb({ rows: [{ ...OPEN_ROW }], onHand: SEED });
    currentDb = db;
    const res = await receiveOrder('o1', [{ sku: 'ZZZ', qty: 1 }]);
    expect(res).toBeNull();
    expect(db._onHand.get('A')!.on_hand_qty).toBe(5); // no stock touched
    expect(db._onHand.get('B')!.on_hand_qty).toBe(1);
    spy.mockRestore();
  });

  it('rejects an INCOMPLETE override — a subset would close the order while the missing lines silently vanish from stock and on-order', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = makeDb({ rows: [{ ...OPEN_ROW }], onHand: SEED });
    currentDb = db;
    const res = await receiveOrder('o1', [{ sku: 'A', qty: 10 }]); // B omitted
    expect(res).toBeNull();
    expect(db._onHand.get('A')!.on_hand_qty).toBe(5);
    expect(db._onHand.get('B')!.on_hand_qty).toBe(1);
    spy.mockRestore();
  });

  it('accepts an unshipped line received explicitly as qty 0', async () => {
    const db = makeDb({ rows: [{ ...OPEN_ROW }], onHand: SEED });
    currentDb = db;
    const res = await receiveOrder('o1', [{ sku: 'A', qty: 10 }, { sku: 'B', qty: 0 }]);
    expect(res).toEqual({ ok: true });
    expect(db._onHand.get('A')!.on_hand_qty).toBe(15);
    expect(db._onHand.get('B')!.on_hand_qty).toBe(1); // 1 + 0
  });

  it('increments a brand-new SKU (no on-hand row yet) via the insert path', async () => {
    const db = makeDb({ rows: [{ ...OPEN_ROW }], onHand: [{ sku: 'A', on_hand_qty: 5, updated_at: 'oh0' }] });
    currentDb = db;
    const res = await receiveOrder('o1');
    expect(res).toEqual({ ok: true });
    expect(db._onHand.get('A')!.on_hand_qty).toBe(15); // 5 + 10
    expect(db._onHand.get('B')!.on_hand_qty).toBe(4); // inserted at the delta
  });

  it('one failed on-hand write does not stop the others or unwind the claim', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = makeDb({ rows: [{ ...OPEN_ROW }], onHand: SEED, onHandFailSkus: ['A'] });
    currentDb = db;
    const res = await receiveOrder('o1');
    expect(res).toEqual({ ok: true });
    expect(db._onHand.get('A')!.on_hand_qty).toBe(5); // failed write left it alone
    expect(db._onHand.get('B')!.on_hand_qty).toBe(5); // 1 + 4 still applied
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
