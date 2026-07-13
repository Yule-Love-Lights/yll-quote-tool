import { describe, it, expect, beforeEach, vi } from 'vitest';

// Phase 5 "rebook last season". buildRebookInsert (pure) is tested directly;
// rebookLastSeason runs against the same in-memory Supabase fake, with the
// design clone (designs.cloneDesignToNewQuote) mocked.

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
const { cloneMock } = vi.hoisted(() => ({ cloneMock: vi.fn() }));
// allocateNumber hits an RPC; rebookLastSeason/rebookFromQuote treat any
// failure as "skip the number" (same best-effort pattern as saveQuote).
// Controllable ref so a test can force a rejection.
const { allocRef } = vi.hoisted(() => ({
  allocRef: { current: vi.fn(async () => 1000) as (seq: string) => Promise<number> },
}));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => sbRef.current,
}));
vi.mock('./designs', () => ({ cloneDesignToNewQuote: cloneMock }));
vi.mock('./displayId', () => ({ allocateNumber: (seq: string) => allocRef.current(seq) }));

import { buildRebookInsert, rebookLastSeason, rebookFromQuote } from './rebook';

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
  allocRef.current = vi.fn(async () => 1000);
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

  it('strips ALL frozen rate snapshots (permanent + event + permanent bistro + holiday) so the rebooked draft re-prices at live rates', () => {
    const withSnaps = {
      ...src,
      result: {
        total: 4200,
        lineItems: [{ id: 'permanent-front', amount: 2000 }],
        permanentRatesSnapshot: { frontPerFt: 40, sidesPerFt: 35, backPerFt: 35, minimumJobAmount: 2500, maintenancePrice: 0 },
        eventRatesSnapshot: { rooflinePerFt: 8 },
        permanentBistroRatesSnapshot: { perFt: 30, perPole: 100, minimum: 0 },
        // WT-63: holiday quotes now freeze a rate snapshot too — a rebooked
        // holiday draft must NOT inherit last season's frozen rates.
        holidayRatesSnapshot: { rooflineRates: { easy: 8, medium: 10, hard: 12 } },
      },
    } as unknown as Parameters<typeof buildRebookInsert>[0];
    const result = buildRebookInsert(withSnaps).result as Record<string, unknown>;
    expect(result).not.toHaveProperty('permanentRatesSnapshot');
    expect(result).not.toHaveProperty('eventRatesSnapshot');
    expect(result).not.toHaveProperty('permanentBistroRatesSnapshot');
    expect(result).not.toHaveProperty('holidayRatesSnapshot');
    // Other priced fields survive the strip; total still derives from the source.
    expect(result.total).toBe(4200);
    expect(result.lineItems).toEqual([{ id: 'permanent-front', amount: 2000 }]);
    expect(buildRebookInsert(withSnaps).total).toBe(4200);
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

  it('strips discount + referralCredit from inputs — a rebooked quote re-earns/re-applies its own credit, never clones a spent one (#41 adversarial-review fix)', () => {
    const withCredit = {
      ...src,
      inputs: {
        a: 1,
        discount: { type: 'flat', amount: 125 },
        referralCredit: { amount: 125, consumedRowIds: ['r1', 'r2'] },
      },
    };
    const row = buildRebookInsert(withCredit);
    const inputs = row.inputs as Record<string, unknown>;
    expect(inputs).not.toHaveProperty('discount');
    expect(inputs).not.toHaveProperty('referralCredit');
    // Other input fields survive the strip untouched.
    expect(inputs.a).toBe(1);
  });

  it('is a no-op strip when inputs carry no discount/referralCredit', () => {
    const row = buildRebookInsert(src);
    expect(row.inputs).toEqual({ a: 1 });
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

  // rebook-number-createdby: a rebooked quote must get a sequential quote_number
  // (same allocateNumber('quote_number_seq') as saveQuote) so it isn't stuck on
  // the truncated-UUID fallback and stays findable by number search/sort.
  it('allocates a sequential quote_number on the rebooked row', async () => {
    allocRef.current = vi.fn(async () => 1042);
    const fake = makeFakeSupabase({
      quotes: [{ id: 'a', customer_id: 'c1', customer_approved_at: '2025-01-01', inputs: {}, result: { total: 5 } }],
    });
    sbRef.current = fake.client;
    const res = await rebookLastSeason('c1');
    const created = fake.tables.quotes.find((q) => q.id === res!.quoteId)!;
    expect(created.quote_number).toBe(1042);
  });

  // Best-effort, same as saveQuote: a failed allocation (RPC/sequence missing)
  // must not block the rebook — the column is nullable.
  it('omits quote_number (does not fail) when allocation throws', async () => {
    allocRef.current = vi.fn(async () => {
      throw new Error('sequence missing');
    });
    const fake = makeFakeSupabase({
      quotes: [{ id: 'a', customer_id: 'c1', customer_approved_at: '2025-01-01', inputs: {}, result: { total: 5 } }],
    });
    sbRef.current = fake.client;
    const res = await rebookLastSeason('c1');
    expect(res?.quoteId).toBeTruthy();
    const created = fake.tables.quotes.find((q) => q.id === res!.quoteId)!;
    expect(created.quote_number).toBeUndefined();
  });

  // rebook-number-createdby: the operator performing the rebook (when known)
  // must be stamped as created_by, same actor-audit-trail column saveQuote
  // stamps (#90).
  it('stamps created_by with the operator id when passed', async () => {
    const fake = makeFakeSupabase({
      quotes: [{ id: 'a', customer_id: 'c1', customer_approved_at: '2025-01-01', inputs: {}, result: { total: 5 } }],
    });
    sbRef.current = fake.client;
    const res = await rebookLastSeason('c1', null, 'op-1');
    const created = fake.tables.quotes.find((q) => q.id === res!.quoteId)!;
    expect(created.created_by).toBe('op-1');
  });

  it('defaults created_by to null when no operator id is passed', async () => {
    const fake = makeFakeSupabase({
      quotes: [{ id: 'a', customer_id: 'c1', customer_approved_at: '2025-01-01', inputs: {}, result: { total: 5 } }],
    });
    sbRef.current = fake.client;
    const res = await rebookLastSeason('c1');
    const created = fake.tables.quotes.find((q) => q.id === res!.quoteId)!;
    expect(created.created_by ?? null).toBeNull();
  });
});

// ─── DB: rebookFromQuote (#116 — revive a specific dead quote) ────────────────

describe('rebookFromQuote', () => {
  it('clones a SPECIFIC (terminal) quote into a fresh draft + clones its design, leaving the source intact', async () => {
    const fake = makeFakeSupabase({
      quotes: [
        // A dead/declined quote — the #116 revive target.
        { id: 'dead', customer_id: 'c1', status: 'declined', customer_approved_at: null, customer_email: 'j@x.com', inputs: { v: 7 }, result: { total: 70 }, is_test: false },
        // A different approved quote for the same customer — must NOT be the source.
        { id: 'other', customer_id: 'c1', status: 'approved', customer_approved_at: '2025-01-01', inputs: { v: 9 }, result: { total: 90 } },
      ],
    });
    sbRef.current = fake.client;

    const res = await rebookFromQuote('dead');
    expect(res).toBeTruthy();
    // A new row was inserted (2 → 3); the source 'dead' is untouched.
    expect(fake.tables.quotes).toHaveLength(3);
    expect(fake.tables.quotes.find((q) => q.id === 'dead')!.status).toBe('declined');
    const created = fake.tables.quotes.find((q) => q.id === res!.quoteId)!;
    // Cloned from the SPECIFIED quote (not the approved one), as a fresh draft.
    expect(created.inputs).toEqual({ v: 7 });
    expect(created.status).toBe('draft');
    expect(created.customer_approved_at ?? null).toBeNull();
    // Design clone wired source→new.
    expect(cloneMock).toHaveBeenCalledWith('dead', res!.quoteId);
    expect(res!.designId).toBe('design-clone');
  });

  it('returns null when no quote matches the id (nothing inserted, no clone)', async () => {
    const fake = makeFakeSupabase({
      quotes: [{ id: 'a', customer_id: 'c1', inputs: {}, result: { total: 1 } }],
    });
    sbRef.current = fake.client;
    const res = await rebookFromQuote('missing');
    expect(res).toBeNull();
    expect(fake.tables.quotes).toHaveLength(1);
    expect(cloneMock).not.toHaveBeenCalled();
  });

  it('carries is_test through from the source quote', async () => {
    const fake = makeFakeSupabase({
      quotes: [{ id: 'a', customer_id: 'c1', status: 'cancelled', inputs: {}, result: { total: 5 }, is_test: true }],
    });
    sbRef.current = fake.client;
    const res = await rebookFromQuote('a');
    const created = fake.tables.quotes.find((q) => q.id === res!.quoteId)!;
    expect(created.is_test).toBe(true);
  });

  it('survives a throwing design clone (best-effort)', async () => {
    cloneMock.mockRejectedValue(new Error('storage down'));
    const fake = makeFakeSupabase({
      quotes: [{ id: 'a', customer_id: 'c1', status: 'lost', inputs: {}, result: { total: 5 } }],
    });
    sbRef.current = fake.client;
    const res = await rebookFromQuote('a');
    expect(res?.quoteId).toBeTruthy();
    expect(res?.designId).toBeNull();
  });

  // rebook-number-createdby
  it('allocates a sequential quote_number on the rebooked row', async () => {
    allocRef.current = vi.fn(async () => 2001);
    const fake = makeFakeSupabase({
      quotes: [{ id: 'a', customer_id: 'c1', status: 'declined', inputs: {}, result: { total: 5 } }],
    });
    sbRef.current = fake.client;
    const res = await rebookFromQuote('a');
    const created = fake.tables.quotes.find((q) => q.id === res!.quoteId)!;
    expect(created.quote_number).toBe(2001);
  });

  it('omits quote_number (does not fail) when allocation throws', async () => {
    allocRef.current = vi.fn(async () => {
      throw new Error('sequence missing');
    });
    const fake = makeFakeSupabase({
      quotes: [{ id: 'a', customer_id: 'c1', status: 'declined', inputs: {}, result: { total: 5 } }],
    });
    sbRef.current = fake.client;
    const res = await rebookFromQuote('a');
    expect(res?.quoteId).toBeTruthy();
    const created = fake.tables.quotes.find((q) => q.id === res!.quoteId)!;
    expect(created.quote_number).toBeUndefined();
  });

  it('stamps created_by with the operator id when passed', async () => {
    const fake = makeFakeSupabase({
      quotes: [{ id: 'a', customer_id: 'c1', status: 'declined', inputs: {}, result: { total: 5 } }],
    });
    sbRef.current = fake.client;
    const res = await rebookFromQuote('a', 'op-2');
    const created = fake.tables.quotes.find((q) => q.id === res!.quoteId)!;
    expect(created.created_by).toBe('op-2');
  });

  it('defaults created_by to null when no operator id is passed', async () => {
    const fake = makeFakeSupabase({
      quotes: [{ id: 'a', customer_id: 'c1', status: 'declined', inputs: {}, result: { total: 5 } }],
    });
    sbRef.current = fake.client;
    const res = await rebookFromQuote('a');
    const created = fake.tables.quotes.find((q) => q.id === res!.quoteId)!;
    expect(created.created_by ?? null).toBeNull();
  });
});
