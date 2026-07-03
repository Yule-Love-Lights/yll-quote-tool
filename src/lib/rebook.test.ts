import { describe, it, expect, beforeEach, vi } from 'vitest';

// Phase 5 "rebook last season". buildRebookInsert (pure) is tested directly;
// rebookLastSeason runs against the same in-memory Supabase fake, with the
// design clone (designs.cloneDesignToNewQuote) mocked.

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
const { cloneMock } = vi.hoisted(() => ({ cloneMock: vi.fn() }));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => sbRef.current,
}));
vi.mock('./designs', () => ({ cloneDesignToNewQuote: cloneMock }));

import { buildRebookInsert, rebookLastSeason } from './rebook';

// ─── In-memory Supabase fake (quotes) ───────────────────────────────────────

type Row = Record<string, unknown>;

function makeFakeSupabase(initial: { quotes?: Row[] } = {}) {
  const tables: Record<string, Row[]> = { quotes: initial.quotes ? initial.quotes.map((r) => ({ ...r })) : [] };
  let counter = 0;

  function from(table: string) {
    const rows = tables[table] ?? (tables[table] = []);
    const state = {
      op: null as null | 'select' | 'insert' | 'update',
      insertRow: null as Row | null,
      updateRow: null as Row | null,
      filters: [] as Array<(r: Row) => boolean>,
      orderBy: null as null | { col: string; asc: boolean },
      limitN: null as number | null,
    };
    const match = () => {
      let out = rows.filter((r) => state.filters.every((f) => f(r)));
      if (state.orderBy) {
        const { col, asc } = state.orderBy;
        out = [...out].sort((a, b) => {
          const av = a[col] as never;
          const bv = b[col] as never;
          if (av === bv) return 0;
          const cmp = av < bv ? -1 : 1;
          return asc ? cmp : -cmp;
        });
      }
      if (state.limitN != null) out = out.slice(0, state.limitN);
      return out;
    };
    const doInsert = () => {
      const row = { id: `${table}-${++counter}`, ...state.insertRow };
      rows.push(row);
      return row;
    };
    const builder = {
      select() {
        if (state.op === null) state.op = 'select';
        return builder;
      },
      insert(row: Row) {
        state.op = 'insert';
        state.insertRow = row;
        return builder;
      },
      eq(col: string, val: unknown) {
        state.filters.push((r) => r[col] === val);
        return builder;
      },
      is(col: string, val: unknown) {
        state.filters.push((r) =>
          val === null ? r[col] === null || r[col] === undefined : r[col] === val,
        );
        return builder;
      },
      not(col: string, _op: string, val: unknown) {
        state.filters.push((r) =>
          !(val === null ? r[col] === null || r[col] === undefined : r[col] === val),
        );
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        state.orderBy = { col, asc: opts?.ascending !== false };
        return builder;
      },
      limit(n: number) {
        state.limitN = n;
        return builder;
      },
      async maybeSingle() {
        if (state.op === 'insert') return { data: doInsert(), error: null };
        return { data: match()[0] ?? null, error: null };
      },
      async single() {
        if (state.op === 'insert') return { data: doInsert(), error: null };
        const out = match();
        return { data: out[0] ?? null, error: out[0] ? null : { message: 'no rows' } };
      },
    };
    return builder;
  }
  return { client: { from }, tables };
}

beforeEach(() => {
  sbRef.current = null;
  cloneMock.mockReset();
  cloneMock.mockResolvedValue({ id: 'design-clone' });
});

// ─── Pure: buildRebookInsert ────────────────────────────────────────────────

describe('buildRebookInsert', () => {
  const src = {
    customer_name: 'Jane',
    customer_address: '1 Home St',
    customer_phone: '555',
    customer_email: 'jane@x.com',
    highlevel_contact_id: 'hl1',
    service_type: 'permanent',
    inputs: { a: 1 },
    result: { total: 4200 },
    customer_id: 'cust-1',
    property_id: 'prop-1',
  };

  it('copies customer + priced fields and the customer/property link', () => {
    const row = buildRebookInsert(src);
    expect(row).toMatchObject({
      customer_name: 'Jane',
      customer_email: 'jane@x.com',
      highlevel_contact_id: 'hl1',
      status: 'draft', // explicit, matching saveQuote's invariant
      service_type: 'permanent',
      inputs: { a: 1 },
      total: 4200,
      customer_id: 'cust-1',
      property_id: 'prop-1',
    });
  });

  it('carries NOTHING from the lifecycle — the clone is a fresh draft', () => {
    const row = buildRebookInsert(src);
    expect(row).not.toHaveProperty('id');
    expect(row).not.toHaveProperty('quote_sent_at');
    expect(row).not.toHaveProperty('customer_approved_at');
    expect(row).not.toHaveProperty('deposit_paid_at');
    expect(row).not.toHaveProperty('approval_snapshot');
    expect(row).not.toHaveProperty('created_at');
  });

  it('derives total from result and omits service_type when absent', () => {
    const row = buildRebookInsert({ ...src, service_type: null, result: { total: 99 } });
    expect(row.total).toBe(99);
    expect(row).not.toHaveProperty('service_type');
  });

  it('falls back to safe defaults for missing customer fields', () => {
    const row = buildRebookInsert({
      customer_name: null,
      customer_address: null,
      customer_phone: null,
      customer_email: null,
      inputs: {},
      result: null,
    });
    expect(row.customer_name).toBe('Anonymous');
    expect(row.customer_address).toBe('(no address)');
    expect(row.total).toBe(0);
  });

  it('carries is_test through from the source (W2-002)', () => {
    expect(buildRebookInsert({ ...src, is_test: true }).is_test).toBe(true);
    expect(buildRebookInsert({ ...src, is_test: false }).is_test).toBe(false);
  });

  it('defaults is_test to false when the source omits it', () => {
    const row = buildRebookInsert(src);
    expect(row.is_test).toBe(false);
  });
});

// ─── DB: rebookLastSeason ───────────────────────────────────────────────────

describe('rebookLastSeason', () => {
  it('clones the MOST RECENT approved quote into a fresh draft + clones its design', async () => {
    const fake = makeFakeSupabase({
      quotes: [
        { id: 'old', customer_id: 'c1', customer_approved_at: '2024-12-01', customer_email: 'j@x.com', inputs: {}, result: { total: 10 } },
        { id: 'new', customer_id: 'c1', customer_approved_at: '2025-12-01', customer_email: 'j@x.com', inputs: { v: 2 }, result: { total: 20 } },
        { id: 'draft', customer_id: 'c1', customer_approved_at: null, inputs: {}, result: { total: 0 } },
      ],
    });
    sbRef.current = fake.client;

    const res = await rebookLastSeason('c1');
    expect(res).toBeTruthy();
    // A new quote row was inserted (3 → 4).
    expect(fake.tables.quotes).toHaveLength(4);
    const created = fake.tables.quotes.find((q) => q.id === res!.quoteId)!;
    // Cloned from 'new' (the most recent approved), as a fresh draft.
    expect(created.inputs).toEqual({ v: 2 });
    expect(created.customer_id).toBe('c1');
    expect(created.customer_approved_at ?? null).toBeNull();
    // Design clone wired source→new.
    expect(cloneMock).toHaveBeenCalledWith('new', res!.quoteId);
    expect(res!.designId).toBe('design-clone');
  });

  it('scopes the source to a property when given', async () => {
    const fake = makeFakeSupabase({
      quotes: [
        { id: 'home', customer_id: 'c1', property_id: 'p-home', customer_approved_at: '2025-01-01', inputs: { who: 'home' }, result: { total: 1 } },
        { id: 'rental', customer_id: 'c1', property_id: 'p-rental', customer_approved_at: '2025-06-01', inputs: { who: 'rental' }, result: { total: 1 } },
      ],
    });
    sbRef.current = fake.client;

    const res = await rebookLastSeason('c1', 'p-home');
    const created = fake.tables.quotes.find((q) => q.id === res!.quoteId)!;
    expect(created.inputs).toEqual({ who: 'home' }); // not the more-recent rental
    expect(created.property_id).toBe('p-home');
  });

  it('returns null when the customer has no approved quote to rebook from', async () => {
    const fake = makeFakeSupabase({
      quotes: [{ id: 'd', customer_id: 'c1', customer_approved_at: null, inputs: {}, result: { total: 0 } }],
    });
    sbRef.current = fake.client;
    const res = await rebookLastSeason('c1');
    expect(res).toBeNull();
    expect(fake.tables.quotes).toHaveLength(1); // nothing inserted
    expect(cloneMock).not.toHaveBeenCalled();
  });

  it('still returns the rebooked quote when the design clone yields nothing', async () => {
    cloneMock.mockResolvedValue(null);
    const fake = makeFakeSupabase({
      quotes: [{ id: 'a', customer_id: 'c1', customer_approved_at: '2025-01-01', inputs: {}, result: { total: 5 } }],
    });
    sbRef.current = fake.client;
    const res = await rebookLastSeason('c1');
    expect(res?.quoteId).toBeTruthy();
    expect(res?.designId).toBeNull();
  });

  it('survives a throwing design clone (best-effort)', async () => {
    cloneMock.mockRejectedValue(new Error('storage down'));
    const fake = makeFakeSupabase({
      quotes: [{ id: 'a', customer_id: 'c1', customer_approved_at: '2025-01-01', inputs: {}, result: { total: 5 } }],
    });
    sbRef.current = fake.client;
    const res = await rebookLastSeason('c1');
    expect(res?.quoteId).toBeTruthy();
    expect(res?.designId).toBeNull();
  });

  // W2-002: rebooking a TEST quote must produce a TEST clone — otherwise test
  // data silently becomes real dashboard/jobs/invoices/PO data.
  it('carries is_test through: rebook of an is_test=true source yields an is_test=true clone', async () => {
    const fake = makeFakeSupabase({
      quotes: [
        { id: 'a', customer_id: 'c1', customer_approved_at: '2025-01-01', inputs: {}, result: { total: 5 }, is_test: true },
      ],
    });
    sbRef.current = fake.client;
    const res = await rebookLastSeason('c1');
    const created = fake.tables.quotes.find((q) => q.id === res!.quoteId)!;
    expect(created.is_test).toBe(true);
  });

  it('carries is_test=false through for a real source', async () => {
    const fake = makeFakeSupabase({
      quotes: [
        { id: 'a', customer_id: 'c1', customer_approved_at: '2025-01-01', inputs: {}, result: { total: 5 }, is_test: false },
      ],
    });
    sbRef.current = fake.client;
    const res = await rebookLastSeason('c1');
    const created = fake.tables.quotes.find((q) => q.id === res!.quoteId)!;
    expect(created.is_test).toBe(false);
  });
});
