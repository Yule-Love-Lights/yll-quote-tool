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

import { saveQuote, updateQuote, deleteTestQuotes, deleteAllQuotes } from './quotes';

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

// ── #GHL pipeline sync — cross-pipeline card desync guard ───────────────────
// highlevel_opportunity_id records no pipeline; every GHL move site resolves
// the pipeline from the quote's mutable service_type. When updateQuote CHANGES
// the service type it must clear the opportunity link + sent-stage sync stamp
// (so the next send/attach re-creates the card in the correct pipeline) — and
// must NOT clear on a same-value re-save, an update that omits serviceType, or
// a pre-read failure (fail-open keeps a valid link).

// Fake tuned to updateQuote's two chains:
//   pre-read: from('quotes').select('service_type').eq().maybeSingle() → storedRow
//   write:    from('quotes').update(payload).eq().select('id').single()
function makeUpdateFake(
  storedRow: Record<string, unknown> | null,
  readErr: { message: string } | null = null,
) {
  const updates: Record<string, unknown>[] = [];
  let reads = 0;
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: () => builder,
    eq: () => builder,
    update: (payload: Record<string, unknown>) => {
      updates.push(payload);
      return builder;
    },
    maybeSingle: async () => {
      reads++;
      return { data: readErr ? null : storedRow, error: readErr };
    },
    single: async () => ({ data: { id: 'q1' }, error: null }),
  });
  return { client: { from: () => builder }, updates, readCount: () => reads };
}

describe('updateQuote — service_type change clears the GHL opportunity link', () => {
  it('clears highlevel_opportunity_id + ghl_stage_synced_at when the service type CHANGES', async () => {
    const fake = makeUpdateFake({ service_type: 'holiday' });
    serviceRef.current = fake.client;

    const res = await updateQuote('q1', INPUTS, RESULT, undefined, 'permanent');
    expect(res).toEqual({ id: 'q1' });
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]).toMatchObject({
      service_type: 'permanent',
      highlevel_opportunity_id: null,
      ghl_stage_synced_at: null,
    });
  });

  it('does NOT clear on a same-value re-save', async () => {
    const fake = makeUpdateFake({ service_type: 'permanent' });
    serviceRef.current = fake.client;

    await updateQuote('q1', INPUTS, RESULT, undefined, 'permanent');
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]).toMatchObject({ service_type: 'permanent' });
    expect(fake.updates[0]).not.toHaveProperty('highlevel_opportunity_id');
    expect(fake.updates[0]).not.toHaveProperty('ghl_stage_synced_at');
  });

  it('treats a stored NULL as the holiday default — NULL→holiday is NOT a change', async () => {
    const fake = makeUpdateFake({ service_type: null });
    serviceRef.current = fake.client;

    await updateQuote('q1', INPUTS, RESULT, undefined, 'holiday');
    expect(fake.updates[0]).not.toHaveProperty('highlevel_opportunity_id');
    expect(fake.updates[0]).not.toHaveProperty('ghl_stage_synced_at');
  });

  it('a stored NULL re-saved as permanent IS a pipeline change — clears the link', async () => {
    const fake = makeUpdateFake({ service_type: null });
    serviceRef.current = fake.client;

    await updateQuote('q1', INPUTS, RESULT, undefined, 'permanent');
    expect(fake.updates[0]).toMatchObject({
      highlevel_opportunity_id: null,
      ghl_stage_synced_at: null,
    });
  });

  it('an update that omits serviceType never clears — and never pre-reads', async () => {
    const fake = makeUpdateFake({ service_type: 'holiday' });
    serviceRef.current = fake.client;

    await updateQuote('q1', INPUTS, RESULT);
    expect(fake.readCount()).toBe(0);
    expect(fake.updates[0]).not.toHaveProperty('service_type');
    expect(fake.updates[0]).not.toHaveProperty('highlevel_opportunity_id');
    expect(fake.updates[0]).not.toHaveProperty('ghl_stage_synced_at');
  });

  it('keeps the link when the pre-read fails (fail-open, warns)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = makeUpdateFake(null, { message: 'connection reset' });
    serviceRef.current = fake.client;

    const res = await updateQuote('q1', INPUTS, RESULT, undefined, 'permanent');
    expect(res).toEqual({ id: 'q1' }); // the update itself still succeeds
    expect(fake.updates[0]).toMatchObject({ service_type: 'permanent' });
    expect(fake.updates[0]).not.toHaveProperty('highlevel_opportunity_id');
    expect(fake.updates[0]).not.toHaveProperty('ghl_stage_synced_at');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('service_type pre-read failed'),
      expect.anything(),
    );
    warn.mockRestore();
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

// ── W2-034: deleteAllQuotes' design cleanup runs in bounded-concurrency
// chunks instead of a one-at-a-time await loop. Correctness matters more than
// the exact chunk size here — assert every linked design is still deleted
// (including across a chunk boundary) and the row-delete count still comes
// from the quotes table, not the design loop. ──────────────────────────────

function makeDeleteAllSb(opts: { linkedDesignIds: string[]; quoteDeleteCount: number }) {
  const calls: string[] = [];
  const builder: Record<string, unknown> = {};
  const ret = () => builder;
  for (const m of ['select', 'eq', 'not', 'is']) builder[m] = ret;
  builder.delete = () => builder;
  builder.then = (resolve: (v: unknown) => void) => {
    resolve({
      data: opts.linkedDesignIds.map((id) => ({ id })),
      error: null,
      count: opts.quoteDeleteCount,
    });
  };
  const client = {
    from: (table: string) => {
      calls.push(table);
      return builder;
    },
  };
  return { client, calls };
}

describe('deleteAllQuotes — chunked design cleanup (W2-034)', () => {
  it('deletes every linked design (across a chunk boundary) and returns the quote-delete count', async () => {
    // 10 ids so the 8-per-chunk loop spans two chunks (8 + 2).
    const linkedDesignIds = Array.from({ length: 10 }, (_, i) => `design-${i}`);
    const { client } = makeDeleteAllSb({ linkedDesignIds, quoteDeleteCount: 4 });
    serviceRef.current = client;

    const count = await deleteAllQuotes();

    expect(count).toBe(4);
    expect(deleteDesign).toHaveBeenCalledTimes(10);
    for (const id of linkedDesignIds) {
      expect(deleteDesign).toHaveBeenCalledWith(id);
    }
  });

  it('does nothing design-wise when no designs are linked to a quote', async () => {
    const { client } = makeDeleteAllSb({ linkedDesignIds: [], quoteDeleteCount: 0 });
    serviceRef.current = client;

    expect(await deleteAllQuotes()).toBe(0);
    expect(deleteDesign).not.toHaveBeenCalled();
  });
});

// ── quotes-delete-select-error: a failed designs/quotes lookup must abort the
// bulk delete instead of proceeding as if zero rows needed cleanup — otherwise
// a transient Supabase error orphans design rows + their private-bucket photos
// (the exact PII hole deleteDesign/deleteDesignsForQuote exist to close). ────

describe('deleteAllQuotes — aborts on a failed designs lookup', () => {
  it('throws and never reaches the quote delete when the linked-designs select errors', async () => {
    const calls: string[] = [];
    const builder: Record<string, unknown> = {};
    const ret = () => builder;
    for (const m of ['select', 'eq', 'not', 'is']) builder[m] = ret;
    builder.delete = () => builder;
    builder.then = (resolve: (v: unknown) => void) => {
      resolve({ data: null, error: { message: 'connection reset' }, count: null });
    };
    const client = {
      from: (table: string) => {
        calls.push(table);
        return builder;
      },
    };
    serviceRef.current = client;

    await expect(deleteAllQuotes()).rejects.toThrow(/connection reset/);
    expect(deleteDesign).not.toHaveBeenCalled();
    // Only the failed designs lookup ran — the quotes table was never touched.
    expect(calls).toEqual(['designs']);
  });
});

describe('deleteTestQuotes — aborts on a failed test-rows lookup', () => {
  it('throws and never reaches the quote delete when the is_test select errors', async () => {
    const calls: string[] = [];
    const builder: Record<string, unknown> = {};
    const ret = () => builder;
    for (const m of ['select', 'eq', 'not', 'is']) builder[m] = ret;
    builder.delete = () => builder;
    builder.then = (resolve: (v: unknown) => void) => {
      resolve({ data: null, error: { message: 'connection reset' }, count: null });
    };
    const client = {
      from: (table: string) => {
        calls.push(table);
        return builder;
      },
    };
    serviceRef.current = client;

    await expect(deleteTestQuotes()).rejects.toThrow(/connection reset/);
    expect(deleteDesignsForQuote).not.toHaveBeenCalled();
    expect(calls).toEqual(['quotes']);
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
