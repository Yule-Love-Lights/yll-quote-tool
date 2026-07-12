import { describe, it, expect, beforeEach, vi } from 'vitest';

// Tests for the ledger #72 Jobber CSV import SCAFFOLD. jobberImport.ts's own
// job is: money parsing, row classification (create-new / match-existing /
// skip), the dedup rowKey, and idempotent chunked commits. The customer/
// property find-or-create DEDUP RULES themselves (customerMatchKey,
// normalizeAddress) already have exhaustive coverage in
// src/lib/customers.test.ts — here they're kept REAL (not re-tested) so the
// plan classification exercises the actual rules, while findOrCreateCustomer/
// findOrCreateProperty (the DB writes) are replaced with a tiny in-memory
// double that mirrors the SAME identity-keyed find-or-create semantics.

const { sbRef, customerStore, propertyStore } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  customerStore: new Map<string, string>(), // match_key -> id
  propertyStore: new Map<string, string>(), // `${customerId}::${addressKey}` -> id
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => sbRef.current,
}));

vi.mock('@/lib/customers', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/customers')>();
  let counter = 0;
  return {
    ...actual,
    findOrCreateCustomer: vi.fn(
      async (identity: { name?: string | null; email?: string | null; phone?: string | null }) => {
        const key = actual.customerMatchKey(identity);
        if (!key) return null;
        let id = customerStore.get(key);
        if (!id) {
          id = `cust-${++counter}`;
          customerStore.set(key, id);
        }
        return { id };
      },
    ),
    findOrCreateProperty: vi.fn(async (customerId: string, address: string | null | undefined) => {
      const compositeKey = `${customerId}::${actual.normalizeAddress(address)}`;
      let id = propertyStore.get(compositeKey);
      if (!id) {
        id = `prop-${++counter}`;
        propertyStore.set(compositeKey, id);
      }
      return { id };
    }),
  };
});

import { findOrCreateCustomer, findOrCreateProperty } from '@/lib/customers';
import { parseJobberCsv, planJobberImport, commitJobberImport, type JobberColumnMap } from './jobberImport';

// ─── Fixtures ────────────────────────────────────────────────────────────

function fullMap(overrides: Partial<JobberColumnMap> = {}): JobberColumnMap {
  return {
    sourceId: null,
    customerName: 'Customer Name',
    customerEmail: 'Email',
    customerPhone: 'Phone',
    propertyAddress: 'Address',
    total: 'Total',
    serviceType: 'Service Type',
    status: 'Status',
    customerApprovedAt: 'Approved At',
    quoteSentAt: 'Sent At',
    depositPaidAt: 'Deposit Paid At',
    ...overrides,
  };
}

function row(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'Customer Name': 'Jane Doe',
    Email: 'jane@example.com',
    Phone: '555-123-4567',
    Address: '123 Main St',
    Total: '100.00',
    'Service Type': '',
    Status: '',
    'Approved At': '',
    'Sent At': '',
    'Deposit Paid At': '',
    ...overrides,
  };
}

// ─── In-memory fake `quotes` table ─────────────────────────────────────────
// Supports only the two operations commitJobberImport actually issues:
//   select('inputs').not('inputs->>jobberImportKey', 'is', null)
//   insert({...})

type Row = Record<string, unknown>;

function makeFakeSupabase(opts: { forceInsertError?: { message: string } } = {}) {
  const quotes: Row[] = [];
  let idCounter = 0;
  let forceSelectError: { message: string } | null = null;

  function from(table: string) {
    if (table !== 'quotes') throw new Error(`fake supabase: unexpected table "${table}"`);
    const state: {
      op: null | 'select' | 'insert';
      notFilters: Array<(r: Row) => boolean>;
      insertRow: Row | null;
    } = { op: null, notFilters: [], insertRow: null };

    const builder = {
      select() {
        state.op = 'select';
        return builder;
      },
      insert(row_: Row) {
        state.op = 'insert';
        state.insertRow = row_;
        return builder;
      },
      not(col: string, op: string, val: unknown) {
        if (col === 'inputs->>jobberImportKey' && op === 'is' && val === null) {
          state.notFilters.push((r) => typeof (r.inputs as Row | null)?.jobberImportKey === 'string');
        }
        return builder;
      },
      then(resolve: (v: { data: unknown; error: unknown }) => void) {
        if (state.op === 'insert') {
          if (opts.forceInsertError) return resolve({ data: null, error: opts.forceInsertError });
          const inserted = { id: `quote-${++idCounter}`, ...state.insertRow };
          quotes.push(inserted);
          return resolve({ data: [inserted], error: null });
        }
        if (forceSelectError) return resolve({ data: null, error: forceSelectError });
        const out = quotes.filter((r) => state.notFilters.every((f) => f(r)));
        return resolve({ data: out, error: null });
      },
    };
    return builder;
  }

  return {
    client: { from },
    quotes,
    forceSelectError: (err: { message: string } | null) => {
      forceSelectError = err;
    },
  };
}

beforeEach(() => {
  sbRef.current = null;
  customerStore.clear();
  propertyStore.clear();
  vi.clearAllMocks();
});

// ─── parseJobberCsv ──────────────────────────────────────────────────────

describe('parseJobberCsv', () => {
  it('parses header row + data rows into header-keyed records', () => {
    const csv = 'Customer Name,Email,Total\nJane Doe,jane@x.com,$500.00\nJohn Roe,john@x.com,750';
    const rows = parseJobberCsv(csv);
    expect(rows).toEqual([
      { 'Customer Name': 'Jane Doe', Email: 'jane@x.com', Total: '$500.00' },
      { 'Customer Name': 'John Roe', Email: 'john@x.com', Total: '750' },
    ]);
  });

  it('handles quoted fields containing commas (RFC4180)', () => {
    const csv = 'Customer Name,Address\n"Doe, Jane","123 Main St, Apt 2"';
    const rows = parseJobberCsv(csv);
    expect(rows[0]).toEqual({ 'Customer Name': 'Doe, Jane', Address: '123 Main St, Apt 2' });
  });

  it('skips blank lines', () => {
    const csv = 'A,B\n1,2\n\n3,4\n';
    const rows = parseJobberCsv(csv);
    expect(rows).toHaveLength(2);
  });

  it('handles CRLF line endings', () => {
    const csv = 'A,B\r\n1,2\r\n';
    const rows = parseJobberCsv(csv);
    expect(rows).toEqual([{ A: '1', B: '2' }]);
  });
});

// ─── planJobberImport — pure, no IO ─────────────────────────────────────────

describe('planJobberImport', () => {
  it('performs zero writes — findOrCreateCustomer/findOrCreateProperty are never called', () => {
    const rows = [row(), row({ Email: 'other@example.com' })];
    const plan = planJobberImport(rows, fullMap());
    expect(plan.counts.createNew + plan.counts.matchExisting).toBe(2);
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
    expect(findOrCreateProperty).not.toHaveBeenCalled();
  });

  it('is safe to call with Supabase completely unconfigured (no throw)', () => {
    sbRef.current = null;
    expect(() => planJobberImport([row()], fullMap())).not.toThrow();
  });

  describe('money precision', () => {
    it('parses "$1,234.50" / "1234.5" / "$1,234" to the correct dollar amount', () => {
      const rows = [row({ Total: '$1,234.50' }), row({ Total: '1234.5' }), row({ Total: '$1,234' })];
      const plan = planJobberImport(rows, fullMap());
      expect(plan.rows.map((r) => r.candidate?.quote.total)).toEqual([1234.5, 1234.5, 1234]);
      expect(plan.counts.skip).toBe(0);
    });

    it('rejects a non-numeric or blank total as a skip (never NaN)', () => {
      const rows = [row({ Total: 'N/A' }), row({ Total: '' }), row({ Total: '   ' })];
      const plan = planJobberImport(rows, fullMap());
      expect(plan.counts.skip).toBe(3);
      for (const r of plan.rows) {
        expect(r.action).toBe('skip');
        expect(r.candidate).toBeUndefined();
        expect(r.reason).toMatch(/invalid or missing total/);
      }
    });
  });

  describe('required-field-missing → skip', () => {
    it('skips a row with no customer identity at all (name/email/phone blank)', () => {
      const rows = [row({ 'Customer Name': '', Email: '', Phone: '' })];
      const plan = planJobberImport(rows, fullMap());
      expect(plan.counts.skip).toBe(1);
      expect(plan.rows[0].action).toBe('skip');
      expect(plan.rows[0].reason).toMatch(/missing customer identity/);
      expect(plan.rows[0].candidate).toBeUndefined();
      expect(plan.errors[0]).toMatch(/Row 0: missing customer identity/);
    });

    it('does not skip when only SOME identity fields are blank', () => {
      const rows = [row({ Email: '', Phone: '' })]; // name still present
      const plan = planJobberImport(rows, fullMap());
      expect(plan.counts.skip).toBe(0);
      expect(plan.rows[0].action).toBe('create-new');
    });
  });

  describe('dedup classification (create-new vs match-existing)', () => {
    it('classifies the first occurrence of a customer as create-new and repeats as match-existing', () => {
      const rows = [
        row({ Email: 'jane@x.com', Address: '1 Home St' }),
        row({ Email: 'jane@x.com', Address: '9 Rental Rd' }), // same customer, 2nd property
        row({ Email: 'other@x.com' }),
      ];
      const plan = planJobberImport(rows, fullMap());
      expect(plan.rows[0].action).toBe('create-new');
      expect(plan.rows[1].action).toBe('match-existing');
      expect(plan.rows[2].action).toBe('create-new');
      expect(plan.counts).toEqual({ createNew: 2, matchExisting: 1, skip: 0 });
    });

    it('resolves the SAME match_key/address_key the rest of the app uses (customers.ts rules)', () => {
      // "JANE@X.com" and "jane@x.com" collapse to one match_key (customerMatchKey
      // lowercases email) — proves the REAL helper is reused, not a re-invented rule.
      const rows = [row({ Email: 'JANE@X.com' }), row({ Email: 'jane@x.com' })];
      const plan = planJobberImport(rows, fullMap());
      expect(plan.rows[0].candidate?.customer.matchKey).toBe(plan.rows[1].candidate?.customer.matchKey);
      expect(plan.rows[1].action).toBe('match-existing');
    });
  });

  it('echoes the isTest flag (informational only — the plan never writes)', () => {
    expect(planJobberImport([row()], fullMap()).isTest).toBe(true); // default
    expect(planJobberImport([row()], fullMap(), { isTest: false }).isTest).toBe(false);
  });
});

// ─── commitJobberImport — idempotent writes ─────────────────────────────────

describe('commitJobberImport', () => {
  it('dry-run then commit: planJobberImport alone writes nothing, commitJobberImport performs the writes', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    const plan = planJobberImport([row()], fullMap());
    expect(fake.quotes).toHaveLength(0); // plan alone: nothing written yet

    await commitJobberImport(plan);
    expect(fake.quotes).toHaveLength(1);
  });

  it('is idempotent — committing the SAME plan twice creates no duplicate quotes', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    const plan = planJobberImport([row({ Email: 'jane@x.com', Total: '500' })], fullMap());

    const first = await commitJobberImport(plan);
    expect(first.created).toBe(1);
    expect(first.skippedExisting).toBe(0);
    expect(fake.quotes).toHaveLength(1);

    const second = await commitJobberImport(plan); // re-run the SAME plan
    expect(second.created).toBe(0);
    expect(second.skippedExisting).toBe(1);
    expect(fake.quotes).toHaveLength(1); // still just one row
  });

  it('uses the mapped sourceId as the strongest dedup key when present (overrides the composite fallback)', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    const map = fullMap({ sourceId: 'Job #' });
    const rows = [
      row({ 'Job #': 'J-100', Total: '500' }),
      row({ 'Job #': 'J-100', Total: '999' }), // same Jobber record, total edited between exports
    ];
    const plan = planJobberImport(rows, map);

    const result = await commitJobberImport(plan);
    expect(result.created).toBe(1);
    expect(result.skippedExisting).toBe(1);
    expect(fake.quotes).toHaveLength(1);
  });

  it('dedups the customer + property across rows (same customer_id/property_id), while still writing distinct quotes', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    const rows = [
      row({ Email: 'jane@x.com', Address: '1 Home St', Total: '500', 'Approved At': '2024-01-01' }),
      row({ Email: 'jane@x.com', Address: '1 Home St', Total: '750', 'Approved At': '2024-06-01' }),
    ];
    const plan = planJobberImport(rows, fullMap());

    const result = await commitJobberImport(plan);
    expect(result.created).toBe(2); // two distinct historical jobs
    expect(fake.quotes[0].customer_id).toBe(fake.quotes[1].customer_id); // same customer
    expect(fake.quotes[0].property_id).toBe(fake.quotes[1].property_id); // same property
  });

  it('dedups correctly across a chunk boundary (bounded concurrency, CHUNK_SIZE=8)', async () => {
    const fake = makeFakeSupabase();
    sbRef.current = fake.client;
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({
        Email: 'jane@x.com',
        Address: '1 Home St',
        Total: String(100 + i),
        'Approved At': `2024-01-${String(i + 1).padStart(2, '0')}`,
      }),
    );
    const plan = planJobberImport(rows, fullMap());

    const result = await commitJobberImport(plan);
    expect(result.created).toBe(20);
    expect(fake.quotes).toHaveLength(20);
    expect(new Set(fake.quotes.map((q) => q.customer_id)).size).toBe(1); // one customer for all 20
  });

  describe('required-field-missing → skip, no write', () => {
    it('never writes a quote for a skipped row', async () => {
      const fake = makeFakeSupabase();
      sbRef.current = fake.client;
      const rows = [row({ 'Customer Name': '', Email: '', Phone: '' }), row({ Email: 'ok@x.com' })];
      const plan = planJobberImport(rows, fullMap());

      const result = await commitJobberImport(plan);
      expect(result.attempted).toBe(1); // only the valid row
      expect(fake.quotes).toHaveLength(1);
    });
  });

  describe('is_test isolation', () => {
    it('defaults to is_test=true when isTest is not specified (trial-import isolation)', async () => {
      const fake = makeFakeSupabase();
      sbRef.current = fake.client;
      const plan = planJobberImport([row()], fullMap());
      await commitJobberImport(plan);
      expect(fake.quotes[0].is_test).toBe(true);
    });

    it('writes is_test=false only when explicitly requested (the real go-live commit)', async () => {
      const fake = makeFakeSupabase();
      sbRef.current = fake.client;
      const plan = planJobberImport([row()], fullMap());
      await commitJobberImport(plan, { isTest: false });
      expect(fake.quotes[0].is_test).toBe(false);
    });
  });

  describe('failure handling — never a partial write', () => {
    it('reports a per-row error and does not count it as created when the insert fails', async () => {
      const fake = makeFakeSupabase({ forceInsertError: { message: 'connection reset' } });
      sbRef.current = fake.client;
      const plan = planJobberImport([row()], fullMap());

      const result = await commitJobberImport(plan);
      expect(result.created).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toBe('connection reset');
      expect(fake.quotes).toHaveLength(0);
    });

    it('fails the whole commit cleanly (no throw) when the pre-fetch existing-imports read errors', async () => {
      const fake = makeFakeSupabase();
      fake.forceSelectError({ message: 'db down' });
      sbRef.current = fake.client;
      const plan = planJobberImport([row()], fullMap());

      const result = await commitJobberImport(plan);
      expect(result.created).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toMatch(/db down/);
      expect(fake.quotes).toHaveLength(0);
    });

    it('fails cleanly (no throw) when Supabase is not configured', async () => {
      sbRef.current = null;
      const plan = planJobberImport([row()], fullMap());

      const result = await commitJobberImport(plan);
      expect(result.created).toBe(0);
      expect(result.failed).toBe(1);
      expect(result.errors[0].error).toMatch(/not configured/);
    });
  });
});
