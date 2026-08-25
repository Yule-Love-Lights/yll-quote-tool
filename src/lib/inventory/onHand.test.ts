// src/lib/inventory/onHand.test.ts
import { describe, it, expect } from 'vitest';
import { toQty, adjustOnHandAtomic } from './onHand';

describe('toQty', () => {
  it('clamps to a non-negative integer', () => {
    expect(toQty(5)).toBe(5);
    expect(toQty('12')).toBe(12);
    expect(toQty(3.9)).toBe(3);
    expect(toQty(-4)).toBe(0);
    expect(toQty('abc')).toBe(0);
    expect(toQty(null)).toBe(0);
    expect(toQty(undefined)).toBe(0);
  });
});

// A minimal inventory_on_hand fake modeling the updated_at optimistic-concurrency
// guard (mirrors orders.test.ts): the guarded write only lands when updated_at is
// still the snapshot the caller read, and every successful write bumps updated_at
// (like the before-update trigger). `concurrentBump` simulates another writer (a
// receipt increment or a second job decrement) landing in the read -> write gap.
type OnHandCell = { on_hand_qty: number; updated_at: string };
function makeOnHandDb(opts: {
  onHand?: { sku: string; on_hand_qty: number; updated_at: string }[];
  concurrentBump?: { sku: string; addQty: number };
}) {
  const onHand = new Map<string, OnHandCell>();
  for (const r of opts.onHand ?? []) onHand.set(r.sku, { on_hand_qty: r.on_hand_qty, updated_at: r.updated_at });
  let concurrentBump = opts.concurrentBump ?? null;
  let ver = 0;
  const bump = () => `oh-v${++ver}`;
  return {
    _onHand: onHand,
    from(table: string) {
      if (table !== 'inventory_on_hand') throw new Error(`unexpected table ${table}`);
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
        eq(col: string, val: unknown) {
          st.filters[col] = val;
          return ob;
        },
        async maybeSingle() {
          const sku = st.filters.sku as string;
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
                cur.updated_at = bump();
              }
              concurrentBump = null;
            }
            const cell = onHand.get(sku);
            if (cell && cell.updated_at === st.filters.updated_at) {
              cell.on_hand_qty = st.payload?.on_hand_qty as number;
              cell.updated_at = bump();
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
              resolve({ data: [], error: null });
            } else {
              onHand.set(sku, { on_hand_qty: st.payload?.on_hand_qty as number, updated_at: bump() });
              resolve({ data: [{ sku }], error: null });
            }
            return;
          }
          resolve({ data: [], error: null });
        },
      };
      return ob;
    },
  };
}

describe('adjustOnHandAtomic — atomic signed delta (decrement/increment race)', () => {
  // The core data-integrity guarantee (the DECREMENT half of the on-hand race):
  // a job decrement and a receipt increment on the SAME SKU race. The decrement
  // reads snapshot 100, but a concurrent receipt (+50) lands before its guarded
  // write. The absolute-set path (upsertOnHand({ on_hand_qty: after })) would
  // write 90 and silently drop the +50 — phantom stock. The atomic guard retries
  // against the fresh value: 100 - 10 (this decrement) + 50 (concurrent) = 140.
  it('a decrement that races a concurrent increment ends at the correct net on-hand (no lost delta)', async () => {
    const db = makeOnHandDb({
      onHand: [{ sku: 'A', on_hand_qty: 100, updated_at: 'oh0' }],
      concurrentBump: { sku: 'A', addQty: 50 },
    });
    const r = await adjustOnHandAtomic(db as never, 'A', -10);
    expect(db._onHand.get('A')!.on_hand_qty).toBe(140);
    // The full requested -10 landed (the retry re-read the concurrently-bumped
    // 150 and applied the same -10 against it) — applied matches the request.
    expect(r).toEqual({ before: 150, after: 140, applied: -10 });
  });

  it('floors on-hand at 0 (never negative) when the decrement exceeds stock', async () => {
    const db = makeOnHandDb({ onHand: [{ sku: 'A', on_hand_qty: 3, updated_at: 'oh0' }] });
    const r = await adjustOnHandAtomic(db as never, 'A', -10);
    expect(db._onHand.get('A')!.on_hand_qty).toBe(0);
    // Row 329: the clamp means only 3 of the requested 10 actually came off —
    // `applied` reports the TRUE (smaller-magnitude) delta, not the request.
    // This is exactly the value prepareJobMaterials must persist as its
    // snapshot, or cancel's reversal over-credits on-hand.
    expect(r).toEqual({ before: 3, after: 0, applied: -3 });
  });

  it('applies a positive delta (the receipt path) atomically', async () => {
    const db = makeOnHandDb({ onHand: [{ sku: 'A', on_hand_qty: 5, updated_at: 'oh0' }] });
    const r = await adjustOnHandAtomic(db as never, 'A', 10);
    expect(db._onHand.get('A')!.on_hand_qty).toBe(15);
    expect(r).toEqual({ before: 5, after: 15, applied: 10 });
  });

  it('two concurrent decrements on the same SKU both land (no lost delta)', async () => {
    // Second decrement (-8) lands in the first decrement's read -> write gap; the
    // guard forces a retry so both apply: 20 - 8 - 8 = 4.
    const db = makeOnHandDb({
      onHand: [{ sku: 'A', on_hand_qty: 20, updated_at: 'oh0' }],
      concurrentBump: { sku: 'A', addQty: -8 },
    });
    const r = await adjustOnHandAtomic(db as never, 'A', -8);
    expect(db._onHand.get('A')!.on_hand_qty).toBe(4);
    expect(r).toEqual({ before: 12, after: 4, applied: -8 });
  });
});
