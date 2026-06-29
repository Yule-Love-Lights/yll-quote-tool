import { describe, it, expect, beforeEach, vi } from 'vitest';

// Phase 5 customer/property identity. The pure dedup rules (match key, phone +
// address normalization) are tested directly; the DB helpers run against a small
// in-memory Supabase fake that models the query shapes customers.ts uses
// (select/insert/update + eq/is/order/limit + maybeSingle/single + bare await).

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => sbRef.current,
}));

import {
  customerMatchKey,
  normalizePhone,
  normalizeAddress,
  findOrCreateCustomer,
  findOrCreateProperty,
  attachQuoteToCustomer,
  backfillCustomersFromQuotes,
  getCustomer,
  getPropertiesForCustomer,
} from './customers';

// ─── In-memory Supabase fake ────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeFakeSupabase(initial: { quotes?: Row[]; customers?: Row[]; properties?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    customers: initial.customers ? initial.customers.map((r) => ({ ...r })) : [],
    properties: initial.properties ? initial.properties.map((r) => ({ ...r })) : [],
    quotes: initial.quotes ? initial.quotes.map((r) => ({ ...r })) : [],
  };
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
    const doUpdate = () => {
      const matched = rows.filter((r) => state.filters.every((f) => f(r)));
      for (const r of matched) Object.assign(r, state.updateRow);
      return matched;
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
      update(row: Row) {
        state.op = 'update';
        state.updateRow = row;
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
      then(resolve: (v: unknown) => void) {
        if (state.op === 'insert') return resolve({ data: doInsert(), error: null });
        if (state.op === 'update') return resolve({ data: doUpdate(), error: null });
        return resolve({ data: match(), error: null });
      },
    };
    return builder;
  }

  return { client: { from }, tables };
}

beforeEach(() => {
  sbRef.current = null;
});

// ─── Pure: match key ────────────────────────────────────────────────────────

describe('customerMatchKey', () => {
  it('prefers HL contact id over everything', () => {
    expect(
      customerMatchKey({ hl_contact_id: 'abc', email: 'a@b.com', phone: '555', name: 'Jo' }),
    ).toBe('hl:abc');
  });
  it('falls back email → phone → name', () => {
    expect(customerMatchKey({ email: 'A@B.com' })).toBe('email:a@b.com');
    expect(customerMatchKey({ phone: '(555) 123-4567' })).toBe('phone:5551234567');
    expect(customerMatchKey({ name: 'Jane Doe' })).toBe('name:jane doe');
  });
  it('returns null when there is no identity at all', () => {
    expect(customerMatchKey({})).toBeNull();
    expect(customerMatchKey({ email: '  ', phone: '', name: null })).toBeNull();
  });
  it('collapses case / whitespace so the same customer dedups', () => {
    expect(customerMatchKey({ email: 'jane@x.com' })).toBe(
      customerMatchKey({ email: ' JANE@X.com ' }),
    );
  });
});

describe('normalizePhone', () => {
  it('keeps digits only', () => {
    expect(normalizePhone('+1 (555) 123-4567')).toBe('15551234567');
    expect(normalizePhone('555.123.4567')).toBe('5551234567');
  });
  it('is null without digits', () => {
    expect(normalizePhone('abc')).toBeNull();
    expect(normalizePhone('  ')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe('normalizeAddress', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeAddress('123 Main St.')).toBe('123 main st');
    expect(normalizeAddress('123  MAIN   st')).toBe('123 main st');
    expect(normalizeAddress('45 Oak Ave, #2')).toBe('45 oak ave 2');
  });
  it('is empty string for a blank address', () => {
    expect(normalizeAddress(null)).toBe('');
    expect(normalizeAddress('   ')).toBe('');
  });
  it('maps trivial formatting differences to one key', () => {
    expect(normalizeAddress('10 Elm St.')).toBe(normalizeAddress('10 elm st'));
  });
});

// ─── DB: find-or-create ─────────────────────────────────────────────────────

describe('findOrCreateCustomer', () => {
  it('creates once then returns the SAME id for a matching identity', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;

    const a = await findOrCreateCustomer({ email: 'jane@x.com', name: 'Jane' });
    const b = await findOrCreateCustomer({ email: ' JANE@x.com ' }); // same key
    expect(a?.id).toBeTruthy();
    expect(b?.id).toBe(a?.id);
    expect(fake.tables.customers).toHaveLength(1);
    expect(fake.tables.customers[0].match_key).toBe('email:jane@x.com');
  });

  it('separates distinct identities into distinct customers', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    await findOrCreateCustomer({ email: 'a@x.com' });
    await findOrCreateCustomer({ email: 'b@x.com' });
    expect(fake.tables.customers).toHaveLength(2);
  });

  it('returns null (creates nothing) for an identity-less quote', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    const r = await findOrCreateCustomer({ name: '   ' });
    expect(r).toBeNull();
    expect(fake.tables.customers).toHaveLength(0);
  });
});

describe('findOrCreateProperty', () => {
  it('dedups by normalized address within a customer', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    const p1 = await findOrCreateProperty('cust-1', '123 Main St.');
    const p2 = await findOrCreateProperty('cust-1', '123  main st');
    expect(p2?.id).toBe(p1?.id);
    expect(fake.tables.properties).toHaveLength(1);
    expect(fake.tables.properties[0].address_key).toBe('123 main st');
  });

  it('a second property (rental) for the same customer is a new row', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    await findOrCreateProperty('cust-1', '123 Main St');
    await findOrCreateProperty('cust-1', '9 Rental Rd');
    expect(fake.tables.properties).toHaveLength(2);
  });
});

// ─── DB: attach + backfill ──────────────────────────────────────────────────

describe('attachQuoteToCustomer', () => {
  it('links a quote to a fresh customer + property', async () => {
    const fake = makeFakeSupabase({
      quotes: [{ id: 'q1', customer_email: 'jane@x.com', customer_address: '1 A St' }],
    });
    sbRef.current = fake.client;

    const res = await attachQuoteToCustomer({
      id: 'q1',
      customer_email: 'jane@x.com',
      customer_address: '1 A St',
    });
    expect(res).toBeTruthy();
    const q = fake.tables.quotes.find((r) => r.id === 'q1')!;
    expect(q.customer_id).toBe(res!.customerId);
    expect(q.property_id).toBe(res!.propertyId);
  });

  it('returns null for an identity-less quote (left unlinked)', async () => {
    const fake = makeFakeSupabase({ quotes: [{ id: 'q1' }] });
    sbRef.current = fake.client;
    const res = await attachQuoteToCustomer({ id: 'q1' });
    expect(res).toBeNull();
    expect(fake.tables.customers).toHaveLength(0);
  });
});

describe('backfillCustomersFromQuotes', () => {
  it('dedups a history into stable customers + properties and links each quote', async () => {
    const fake = makeFakeSupabase({
      quotes: [
        // Same customer (email), two addresses (home + rental)
        { id: 'q1', created_at: '2025-01-01', customer_email: 'jane@x.com', customer_address: '1 Home St', customer_id: null },
        { id: 'q2', created_at: '2025-02-01', customer_email: 'jane@x.com', customer_address: '9 Rental Rd', customer_id: null },
        { id: 'q3', created_at: '2025-03-01', customer_email: 'jane@x.com', customer_address: '1 Home St', customer_id: null },
        // A different customer
        { id: 'q4', created_at: '2025-04-01', customer_phone: '555-111-2222', customer_address: '2 B Ave', customer_id: null },
        // Identity-less → skipped
        { id: 'q5', created_at: '2025-05-01', customer_id: null },
      ],
    });
    sbRef.current = fake.client;

    const summary = await backfillCustomersFromQuotes();
    expect(summary.scanned).toBe(5);
    expect(summary.linked).toBe(4);
    expect(summary.skipped).toBe(1);
    expect(fake.tables.customers).toHaveLength(2); // Jane + the phone customer
    expect(fake.tables.properties).toHaveLength(3); // Home, Rental, B Ave

    const jane = fake.tables.customers.find((c) => c.match_key === 'email:jane@x.com')!;
    const janeQuotes = fake.tables.quotes.filter((q) => q.customer_id === jane.id);
    expect(janeQuotes.map((q) => q.id).sort()).toEqual(['q1', 'q2', 'q3']);
    // q1 and q3 (same address) share ONE property; q2 is the rental.
    const q1 = fake.tables.quotes.find((q) => q.id === 'q1')!;
    const q3 = fake.tables.quotes.find((q) => q.id === 'q3')!;
    expect(q1.property_id).toBe(q3.property_id);
    expect(fake.tables.quotes.find((q) => q.id === 'q5')!.customer_id).toBeNull();
  });

  it('is idempotent — a re-run only scans the still-unlinked quotes', async () => {
    const fake = makeFakeSupabase({
      quotes: [{ id: 'q1', created_at: '2025-01-01', customer_email: 'a@x.com', customer_address: 'X', customer_id: null }],
    });
    sbRef.current = fake.client;
    await backfillCustomersFromQuotes();
    const second = await backfillCustomersFromQuotes();
    expect(second.scanned).toBe(0); // q1 now has customer_id → not re-scanned
    expect(fake.tables.customers).toHaveLength(1);
  });

  it('EXCLUDES test quotes from promotion (ledger #93) — real + legacy NULL only', async () => {
    const fake = makeFakeSupabase({
      quotes: [
        { id: 'real', created_at: '2025-01-01', customer_email: 'real@x.com', customer_address: '1 Real St', customer_id: null, is_test: false },
        // Legacy row written before the is_test column existed (NULL/undefined) → real.
        { id: 'legacy', created_at: '2025-02-01', customer_email: 'legacy@x.com', customer_address: '2 Legacy Rd', customer_id: null },
        { id: 'test', created_at: '2025-03-01', customer_email: 'test@x.com', customer_address: '3 Test Ave', customer_id: null, is_test: true },
      ],
    });
    sbRef.current = fake.client;

    const summary = await backfillCustomersFromQuotes();
    // The test quote is filtered out of the scan entirely.
    expect(summary.scanned).toBe(2);
    expect(summary.linked).toBe(2);
    // It never gets linked and never creates a persisted customer (so "Delete
    // test data" can't leave an orphaned customer/property behind).
    expect(fake.tables.quotes.find((q) => q.id === 'test')!.customer_id ?? null).toBeNull();
    expect(fake.tables.customers.map((c) => c.match_key)).not.toContain('email:test@x.com');
  });
});

// ─── DB: reads ──────────────────────────────────────────────────────────────

describe('reads', () => {
  it('getCustomer + getPropertiesForCustomer round-trip after a backfill', async () => {
    const fake = makeFakeSupabase({
      quotes: [
        { id: 'q1', created_at: '2025-01-01', customer_email: 'jane@x.com', customer_address: 'Home', customer_id: null },
        { id: 'q2', created_at: '2025-02-01', customer_email: 'jane@x.com', customer_address: 'Rental', customer_id: null },
      ],
    });
    sbRef.current = fake.client;
    await backfillCustomersFromQuotes();
    const id = fake.tables.customers[0].id as string;

    const c = await getCustomer(id);
    expect(c?.email).toBe('jane@x.com');
    const props = await getPropertiesForCustomer(id);
    expect(props).toHaveLength(2);
  });

  it('returns safe empties when Supabase is unconfigured', async () => {
    sbRef.current = null;
    expect(await getCustomer('x')).toBeNull();
    expect(await getPropertiesForCustomer('x')).toEqual([]);
    expect(await findOrCreateCustomer({ email: 'a@x.com' })).toBeNull();
  });
});
