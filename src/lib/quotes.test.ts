import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { QuoteInputs, QuoteResult } from './pricing/pricingEngine';

// Two concerns covered here:
//  1) #90 RLS hardening — saveQuote / updateQuote write through the RLS-bypassing
//     SERVICE-ROLE client (preferring it over anon) so they keep working once RLS
//     is enabled on the quotes table.
//  2) #93 Test Quote — saveQuote persists is_test, and deleteTestQuotes removes
//     ONLY test rows (cleaning each one's linked design first, mirroring deleteQuote).
// Both run against small in-memory Supabase fakes; displayId + designs are mocked.

const { serviceRef, anonRef } = vi.hoisted(() => ({
  serviceRef: { current: null as unknown },
  anonRef: { current: null as unknown },
}));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => serviceRef.current,
  getSupabaseClient: () => anonRef.current,
}));

// allocateNumber hits an RPC; saveQuote treats any failure as "skip the number".
vi.mock('./displayId', () => ({ allocateNumber: vi.fn(async () => 1000) }));

const { deleteDesign, deleteDesignsForQuote } = vi.hoisted(() => ({
  deleteDesign: vi.fn(async () => {}),
  deleteDesignsForQuote: vi.fn(async () => {}),
}));
vi.mock('./designs', () => ({ deleteDesign, deleteDesignsForQuote }));

// Rebook Part A: mock customers so the attach-on-save wiring is testable here,
// and so existing tests (which don't configure a full customers table) don't blow
// up when saveQuote now calls attachQuoteToCustomer.
const { attachQuoteToCustomerMock } = vi.hoisted(() => ({
  attachQuoteToCustomerMock: vi.fn(async () => null as null | { customerId: string; propertyId: string }),
}));
vi.mock('./customers', () => ({ attachQuoteToCustomer: attachQuoteToCustomerMock }));

import { saveQuote, updateQuote, deleteTestQuotes } from './quotes';

// ── Fake A (#90): records which CLIENT a write goes through (service vs anon),
// so a test can assert the RLS-safe path. ───────────────────────────────────
function makeFake() {
  const fromCalls: string[] = [];
  const inserts: Record<string, unknown>[] = [];
  const builder: Record<string, unknown> = {};
  const ret = () => builder;
  for (const m of ['select', 'update', 'delete', 'eq', 'is', 'not', 'in', 'order', 'limit']) {
    builder[m] = ret;
  }
  builder.insert = (row: Record<string, unknown>) => {
    inserts.push(row);
    return builder;
  };
  builder.single = async () => ({ data: { id: 'new-id' }, error: null });
  builder.maybeSingle = async () => ({ data: { id: 'new-id' }, error: null });
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
  const client = {
    from: (t: string) => {
      fromCalls.push(t);
      return builder;
    },
    rpc: async () => ({ data: 1, error: null }),
  };
  return { client, fromCalls, inserts };
}

// ── Fake B (#93): in-memory tables, for is_test + scoped-delete assertions. ──
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

const INPUTS = {} as QuoteInputs;
const RESULT = { total: 100 } as QuoteResult;
const customer = { name: 'Jane', address: '1 A St' };
const inputs = {} as unknown as QuoteInputs;
const result = { total: 100 } as unknown as QuoteResult;

beforeEach(() => {
  serviceRef.current = null;
  anonRef.current = null;
  vi.clearAllMocks();
});

// ── #90: RLS-safe client routing ────────────────────────────────────────────

describe('saveQuote', () => {
  it('writes through the service-role client when configured (RLS-safe)', async () => {
    const service = makeFake();
    const anon = makeFake();
    serviceRef.current = service.client;
    anonRef.current = anon.client;

    const res = await saveQuote({ name: 'Jane' }, INPUTS, RESULT);

    expect(res).toEqual({ id: 'new-id' });
    expect(service.fromCalls).toContain('quotes');
    expect(anon.fromCalls).not.toContain('quotes');
  });

  it('falls back to the anon client when no service client (dev)', async () => {
    const anon = makeFake();
    anonRef.current = anon.client;

    const res = await saveQuote({ name: 'Jane' }, INPUTS, RESULT);

    expect(res).toEqual({ id: 'new-id' });
    expect(anon.fromCalls).toContain('quotes');
  });

  it('returns null when Supabase is unconfigured', async () => {
    expect(await saveQuote({ name: 'Jane' }, INPUTS, RESULT)).toBeNull();
  });
});

describe('updateQuote', () => {
  it('writes through the service-role client when configured (RLS-safe)', async () => {
    const service = makeFake();
    const anon = makeFake();
    serviceRef.current = service.client;
    anonRef.current = anon.client;

    const res = await updateQuote('q1', INPUTS, RESULT);

    expect(res).toEqual({ id: 'new-id' });
    expect(service.fromCalls).toContain('quotes');
    expect(anon.fromCalls).not.toContain('quotes');
  });

  it('returns null when Supabase is unconfigured', async () => {
    expect(await updateQuote('q1', INPUTS, RESULT)).toBeNull();
  });
});

// #90 actor audit trail: saveQuote stamps created_by (the operator's user id).
describe('saveQuote created_by', () => {
  it('writes the caller id into created_by on insert', async () => {
    const service = makeFake();
    serviceRef.current = service.client;

    // saveQuote(customer, inputs, result, serviceType, isTest, createdBy)
    await saveQuote({ name: 'Jane' }, INPUTS, RESULT, undefined, false, 'op-1');

    expect(service.inserts[0]).toMatchObject({ created_by: 'op-1' });
  });

  it('writes created_by null when no caller id (dormant auth)', async () => {
    const service = makeFake();
    serviceRef.current = service.client;

    await saveQuote({ name: 'Jane' }, INPUTS, RESULT);

    expect(service.inserts[0]).toMatchObject({ created_by: null });
  });
});

// ── #93: Test Quote flag + scoped cleanup ───────────────────────────────────

describe('saveQuote — is_test (ledger #93)', () => {
  it('persists is_test=true when the test flag is passed', async () => {
    const fake = makeFakeSupabase();
    serviceRef.current = fake.client;
    const res = await saveQuote(customer, inputs, result, undefined, true);
    expect(res?.id).toBeTruthy();
    expect(fake.tables.quotes).toHaveLength(1);
    expect(fake.tables.quotes[0].is_test).toBe(true);
  });

  it('defaults is_test=false for a normal quote', async () => {
    const fake = makeFakeSupabase();
    serviceRef.current = fake.client;
    await saveQuote(customer, inputs, result);
    expect(fake.tables.quotes[0].is_test).toBe(false);
  });
});

describe('deleteTestQuotes — ledger #93 cleanup', () => {
  it('deletes ONLY test quotes, cleans each one design first, and returns the count', async () => {
    const fake = makeFakeSupabase({
      quotes: [
        { id: 'real-1', is_test: false },
        { id: 'test-1', is_test: true },
        { id: 'test-2', is_test: true },
      ],
    });
    serviceRef.current = fake.client;

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
    serviceRef.current = fake.client;
    expect(await deleteTestQuotes()).toBe(0);
    expect(deleteDesignsForQuote).not.toHaveBeenCalled();
    expect(fake.tables.quotes).toHaveLength(1);
  });
});

// ── Rebook Part A: attach-on-save ───────────────────────────────────────────
//
// saveQuote now calls attachQuoteToCustomer after a successful insert.
// The mock above (attachQuoteToCustomerMock) lets us assert on the call.

describe('saveQuote — attach-on-save (rebook Part A)', () => {
  it('calls attachQuoteToCustomer with the new quote id for a real (non-test) quote', async () => {
    attachQuoteToCustomerMock.mockResolvedValueOnce({ customerId: 'c1', propertyId: 'p1' });
    const service = makeFake();
    serviceRef.current = service.client;

    const res = await saveQuote({ name: 'Bob', email: 'bob@x.com', phone: '555', address: '2 St' }, INPUTS, RESULT);
    expect(res).toEqual({ id: 'new-id' });
    expect(attachQuoteToCustomerMock).toHaveBeenCalledOnce();
    expect(attachQuoteToCustomerMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new-id' }),
    );
  });

  it('does NOT call attachQuoteToCustomer for a test quote (is_test=true)', async () => {
    const service = makeFake();
    serviceRef.current = service.client;

    const res = await saveQuote({ name: 'Test' }, INPUTS, RESULT, undefined, true);
    expect(res).toEqual({ id: 'new-id' });
    expect(attachQuoteToCustomerMock).not.toHaveBeenCalled();
  });

  it('still returns the saved id when attachQuoteToCustomer throws (best-effort)', async () => {
    attachQuoteToCustomerMock.mockRejectedValueOnce(new Error('link down'));
    const service = makeFake();
    serviceRef.current = service.client;

    const res = await saveQuote({ name: 'Jane' }, INPUTS, RESULT);
    expect(res).toEqual({ id: 'new-id' }); // save succeeds despite attach failure
  });
});
