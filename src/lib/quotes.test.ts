import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QuoteInputs, QuoteResult } from './pricing/pricingEngine';

// Data-layer coverage for the Test Quote flag (ledger #93): saveQuote persists
// is_test, and deleteTestQuotes removes ONLY test rows (cleaning each one's
// linked design first, mirroring deleteQuote). Runs against a small in-memory
// Supabase fake modeling the chains quotes.ts uses (insert/select/single +
// delete{count}/eq + select/eq/bare-await). displayId + designs are mocked.

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => sbRef.current,
}));

// allocateNumber hits an RPC; saveQuote treats any failure as "skip the number".
vi.mock('./displayId', () => ({ allocateNumber: vi.fn(async () => 1000) }));

const { deleteDesign, deleteDesignsForQuote } = vi.hoisted(() => ({
  deleteDesign: vi.fn(async () => {}),
  deleteDesignsForQuote: vi.fn(async () => {}),
}));
vi.mock('./designs', () => ({ deleteDesign, deleteDesignsForQuote }));

import { saveQuote, deleteTestQuotes } from './quotes';

// ─── In-memory Supabase fake ────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeFakeSupabase(initial: { quotes?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    quotes: initial.quotes ? initial.quotes.map((r) => ({ ...r })) : [],
  };
  let counter = 0;

  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    const state = {
      op: 'select' as 'select' | 'insert' | 'delete',
      insertRow: null as Row | null,
      countExact: false,
      filters: [] as Array<(r: Row) => boolean>,
    };
    const apply = () => rows.filter((r) => state.filters.every((f) => f(r)));
    const doInsert = () => {
      const row = { id: `${table}-${++counter}`, ...state.insertRow };
      rows.push(row);
      return row;
    };
    const builder = {
      select() {
        return builder;
      },
      insert(row: Row) {
        state.op = 'insert';
        state.insertRow = row;
        return builder;
      },
      delete(opts?: { count?: string }) {
        state.op = 'delete';
        state.countExact = opts?.count === 'exact';
        return builder;
      },
      eq(col: string, val: unknown) {
        state.filters.push((r) => r[col] === val);
        return builder;
      },
      async single() {
        if (state.op === 'insert') return { data: doInsert(), error: null };
        const out = apply();
        return { data: out[0] ?? null, error: out[0] ? null : { message: 'no rows' } };
      },
      then(resolve: (v: unknown) => void) {
        if (state.op === 'delete') {
          const matched = apply();
          for (const m of matched) {
            const i = rows.indexOf(m);
            if (i >= 0) rows.splice(i, 1);
          }
          return resolve({ error: null, count: state.countExact ? matched.length : null });
        }
        if (state.op === 'insert') return resolve({ data: doInsert(), error: null });
        return resolve({ data: apply(), error: null });
      },
    };
    return builder;
  }

  return { client: { from }, tables };
}

const customer = { name: 'Jane', address: '1 A St' };
const inputs = {} as unknown as QuoteInputs;
const result = { total: 100 } as unknown as QuoteResult;

beforeEach(() => {
  sbRef.current = null;
  vi.clearAllMocks();
});

// ─── saveQuote: is_test ─────────────────────────────────────────────────────

describe('saveQuote — is_test (ledger #93)', () => {
  it('persists is_test=true when the test flag is passed', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    const res = await saveQuote(customer, inputs, result, undefined, true);
    expect(res?.id).toBeTruthy();
    expect(fake.tables.quotes).toHaveLength(1);
    expect(fake.tables.quotes[0].is_test).toBe(true);
  });

  it('defaults is_test=false for a normal quote', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    await saveQuote(customer, inputs, result);
    expect(fake.tables.quotes[0].is_test).toBe(false);
  });
});

// ─── deleteTestQuotes: scoped cleanup ───────────────────────────────────────

describe('deleteTestQuotes — ledger #93 cleanup', () => {
  it('deletes ONLY test quotes, cleans each one design first, and returns the count', async () => {
    const fake = makeFakeSupabase({
      quotes: [
        { id: 'real-1', is_test: false },
        { id: 'test-1', is_test: true },
        { id: 'test-2', is_test: true },
      ],
    });
    sbRef.current = fake.client;

    const count = await deleteTestQuotes();
    expect(count).toBe(2);
    // Real data survives; both test quotes are gone.
    expect(fake.tables.quotes.map((q) => q.id)).toEqual(['real-1']);
    // Each test quote's linked design was erased BEFORE the row (orphan safety).
    expect(deleteDesignsForQuote).toHaveBeenCalledTimes(2);
    expect(deleteDesignsForQuote).toHaveBeenCalledWith('test-1');
    expect(deleteDesignsForQuote).toHaveBeenCalledWith('test-2');
  });

  it('is idempotent — returns 0 and touches nothing when no test quotes exist', async () => {
    const fake = makeFakeSupabase({ quotes: [{ id: 'real-1', is_test: false }] });
    sbRef.current = fake.client;
    expect(await deleteTestQuotes()).toBe(0);
    expect(deleteDesignsForQuote).not.toHaveBeenCalled();
    expect(fake.tables.quotes).toHaveLength(1);
  });
});
