import { describe, it, expect, beforeEach, vi } from 'vitest';

// Phase 3 invoices. computeInvoiceTotals (pure) is tested directly; the DB
// helpers run against an in-memory Supabase fake (jobs/quotes/invoices + an rpc
// for the display-number allocator).

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => sbRef.current,
}));

import {
  computeInvoiceTotals,
  createInvoiceFromJob,
  getInvoiceByJob,
  getInvoiceByQuote,
  getInvoiceDetail,
  listInvoicesForAdmin,
  listInvoicesForCustomer,
  markInvoicePaidManually,
  updateInvoicePaymentReference,
  InvoiceSettleError,
  appendRetiredTxn,
  mergeInvoicesNewestFirst,
  reconcileInvoice,
  setInvoiceStatus,
  setInvoiceTaxOverride,
  type InvoiceRow,
} from './invoices';

// ─── In-memory Supabase fake ────────────────────────────────────────────────

type Row = Record<string, unknown>;

function makeFakeSupabase(initial: { jobs?: Row[]; quotes?: Row[]; invoices?: Row[] } = {}) {
  const tables: Record<string, Row[]> = {
    jobs: initial.jobs ? initial.jobs.map((r) => ({ ...r })) : [],
    quotes: initial.quotes ? initial.quotes.map((r) => ({ ...r })) : [],
    invoices: initial.invoices ? initial.invoices.map((r) => ({ ...r })) : [],
  };
  let counter = 0;
  let seq = 999;

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
      const matched = match();
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
      neq(col: string, val: unknown) {
        state.filters.push((r) => r[col] !== val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        state.filters.push((r) => vals.includes(r[col]));
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
        if (state.op === 'update') return { data: doUpdate()[0] ?? null, error: null };
        return { data: match()[0] ?? null, error: null };
      },
      async single() {
        if (state.op === 'insert') return { data: doInsert(), error: null };
        const out = state.op === 'update' ? doUpdate() : match();
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

  async function rpc() {
    return { data: ++seq, error: null }; // monotonic display number
  }

  return { client: { from, rpc }, tables };
}

beforeEach(() => {
  sbRef.current = null;
});

// ─── Pure: computeInvoiceTotals ─────────────────────────────────────────────

describe('computeInvoiceTotals', () => {
  // $5000 work, $500 discount, 8.75% tax on $4500 = $393.75, total $4893.75,
  // 50% deposit = $2446.88 (rounds up the half-cent).
  const pricing = {
    subtotalBeforeDiscount: 5000,
    discountAmount: 500,
    earlyInstallDiscountAmount: 0,
    taxAmount: 393.75,
    total: 4893.75,
    depositAmount: 2446.88,
  };

  it('applies the paid deposit → balance = total − deposit', () => {
    const t = computeInvoiceTotals(pricing, 2446.88);
    expect(t.total).toBe(4893.75);
    expect(t.tax).toBe(393.75);
    expect(t.deposit_applied).toBe(2446.88);
    expect(t.balance).toBe(2446.87);
    expect(t.credit_note).toBe(0);
  });

  it('zeroes tax and drops the tax line from the total when overridden', () => {
    const t = computeInvoiceTotals(pricing, 2446.88, { taxOverridden: true });
    expect(t.tax).toBe(0);
    expect(t.total).toBe(4500); // 4893.75 − 393.75
    expect(t.balance).toBe(2053.12); // 4500 − 2446.88
  });

  it('clamps balance at 0 and surfaces a credit_note when the deposit overpays', () => {
    // An amended-DOWN order: total now below the already-paid deposit.
    const t = computeInvoiceTotals({ total: 1000, taxAmount: 0 }, 1500);
    expect(t.balance).toBe(0);
    expect(t.credit_note).toBe(500);
  });

  it('handles a never-paid deposit (balance = full total)', () => {
    const t = computeInvoiceTotals(pricing, 0);
    expect(t.deposit_applied).toBe(0);
    expect(t.balance).toBe(4893.75);
  });

  it('rounds money to cents and never emits NaN', () => {
    const t = computeInvoiceTotals(
      { subtotalBeforeDiscount: 0.1 + 0.2, taxAmount: NaN, total: 100.005 },
      33.335,
    );
    expect(t.subtotal).toBe(0.3);
    expect(t.tax).toBe(0); // NaN coerced
    expect(t.total).toBe(100.01);
    expect(t.deposit_applied).toBe(33.34);
    expect(Number.isNaN(t.balance)).toBe(false);
  });

  // B4 fix: rush/takedown fees must be represented in the breakdown so that
  // Subtotal − Discount + Fees + Tax === Total (to the cent).
  it('includes rush + takedown fees in the breakdown and the identity holds', () => {
    // E.g. $4,500 subtotal, $300 rush+takedown fees, 8.75% tax on $4,800 = $420
    // total = $5,220.
    const pricing = {
      subtotalBeforeDiscount: 4500,
      discountAmount: 0,
      earlyInstallDiscountAmount: 0,
      rushFeeAmount: 150,
      takedownAmount: 150,
      taxAmount: 420,
      total: 5220,
    };
    const t = computeInvoiceTotals(pricing, 2610); // 50% deposit
    expect(t.fees).toBe(300);
    // Breakdown identity: subtotal − discount + fees + tax === total
    expect(t.subtotal - t.discount + t.fees + t.tax).toBe(t.total);
    expect(t.total).toBe(5220);
    expect(t.balance).toBe(2610);
  });

  it('fees defaults to 0 when not present in the pricing input (backward compat)', () => {
    const t = computeInvoiceTotals(
      { subtotalBeforeDiscount: 920, discountAmount: 0, taxAmount: 80, total: 1000 },
      500,
    );
    expect(t.fees).toBe(0);
    // Identity: subtotal − discount + fees + tax === total
    expect(t.subtotal - t.discount + t.fees + t.tax).toBeCloseTo(t.total, 2);
  });
});

// ─── DB: createInvoiceFromJob ───────────────────────────────────────────────

describe('createInvoiceFromJob', () => {
  const quote = {
    id: 'q1',
    result: {
      subtotalBeforeDiscount: 5000,
      discountAmount: 500,
      taxAmount: 393.75,
      total: 4893.75,
      depositAmount: 2446.88,
    },
    deposit_amount_usd: 2446.88,
    deposit_paid_at: '2025-01-01T00:00:00Z',
  };

  it('snapshots totals, applies the actual paid deposit, carries customer, numbers it', async () => {
    const fake = makeFakeSupabase({ jobs: [{ id: 'j1', quote_id: 'q1', customer_id: 'c1' }], quotes: [quote] });
    sbRef.current = fake.client;

    const inv = await createInvoiceFromJob('j1');
    expect(inv).toBeTruthy();
    expect(inv!.total).toBe(4893.75);
    expect(inv!.deposit_applied).toBe(2446.88);
    expect(inv!.balance).toBe(2446.87);
    expect(inv!.customer_id).toBe('c1');
    expect(inv!.status).toBe('draft');
    expect(inv!.invoice_number).toBe(1000); // first allocation
    expect(fake.tables.invoices).toHaveLength(1);
  });

  it('is idempotent — a second call returns the same invoice, creates no second', async () => {
    const fake = makeFakeSupabase({ jobs: [{ id: 'j1', quote_id: 'q1', customer_id: 'c1' }], quotes: [quote] });
    sbRef.current = fake.client;
    const a = await createInvoiceFromJob('j1');
    const b = await createInvoiceFromJob('j1');
    expect(b!.id).toBe(a!.id);
    expect(fake.tables.invoices).toHaveLength(1);
  });

  it('uses deposit_applied = 0 when the deposit was never confirmed paid', async () => {
    const unpaid = { ...quote, deposit_paid_at: null };
    const fake = makeFakeSupabase({ jobs: [{ id: 'j1', quote_id: 'q1', customer_id: null }], quotes: [unpaid] });
    sbRef.current = fake.client;
    const inv = await createInvoiceFromJob('j1');
    expect(inv!.deposit_applied).toBe(0);
    expect(inv!.balance).toBe(4893.75);
  });

  it('falls back to the computed 50% when deposit_amount_usd is missing (legacy)', async () => {
    const legacy = { ...quote, deposit_amount_usd: null };
    const fake = makeFakeSupabase({ jobs: [{ id: 'j1', quote_id: 'q1', customer_id: null }], quotes: [legacy] });
    sbRef.current = fake.client;
    const inv = await createInvoiceFromJob('j1');
    expect(inv!.deposit_applied).toBe(2446.88); // result.depositAmount
  });

  it('recovers the existing invoice on a 23505 unique-violation race', async () => {
    // Race: the idempotency guard sees no invoice, the insert loses to the
    // winner's partial-unique-index on job_id, and the creator converges on the
    // winner instead of returning null.
    const winner = { id: 'inv-win', job_id: 'j1', status: 'draft' };
    let invRead = 0;
    let table = '';
    let mode: 'read' | 'insert' = 'read';
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      from: (t: string) => {
        table = t;
        mode = 'read';
        return b;
      },
      select: () => b,
      insert: () => {
        mode = 'insert';
        return b;
      },
      eq: () => b,
      async maybeSingle() {
        if (table === 'invoices') {
          invRead += 1;
          return { data: invRead === 1 ? null : winner, error: null }; // null first (guard), winner on recovery
        }
        if (table === 'jobs') return { data: { id: 'j1', quote_id: 'q1', customer_id: null }, error: null };
        if (table === 'quotes')
          return { data: { id: 'q1', result: { total: 100 }, deposit_amount_usd: 0, deposit_paid_at: null }, error: null };
        return { data: null, error: null };
      },
      async single() {
        return mode === 'insert'
          ? { data: null, error: { code: '23505', message: 'duplicate key' } }
          : { data: null, error: null };
      },
      async rpc() {
        return { data: 1000, error: null };
      },
    });
    sbRef.current = b;

    const inv = await createInvoiceFromJob('j1');
    expect(inv).toMatchObject({ id: 'inv-win' });
  });

  it('returns null when the job has no quote', async () => {
    const fake = makeFakeSupabase({ jobs: [{ id: 'j1', quote_id: null, customer_id: null }] });
    sbRef.current = fake.client;
    expect(await createInvoiceFromJob('j1')).toBeNull();
    expect(fake.tables.invoices).toHaveLength(0);
  });

  // W1-001: the customer approves a SELECTION (approval_snapshot.currentTotalUsd)
  // that can diverge from the FULL quote.result.total — the invoice must bill the
  // AGREED selection total, not the full-quote total (over/under-billing bug).
  it('bills the AGREED selection total, not result.total, when the snapshot diverges', async () => {
    // Full quote priced $5,437.50; the customer picked a cheaper tier + deselected
    // an item → approved $3,697.50 selection, paid a $1,848.75 (50%) deposit.
    const diverged = {
      id: 'q1',
      result: { subtotalBeforeDiscount: 5000, discountAmount: 0, taxAmount: 437.5, total: 5437.5 },
      approval_snapshot: { customerSelection: { currentTotalUsd: 3697.5, selectedItemIds: ['mini-0'] } },
      deposit_amount_usd: 1848.75,
      deposit_paid_at: '2025-01-01T00:00:00Z',
    };
    const fake = makeFakeSupabase({ jobs: [{ id: 'j1', quote_id: 'q1', customer_id: 'c1' }], quotes: [diverged] });
    sbRef.current = fake.client;

    const inv = await createInvoiceFromJob('j1');
    expect(inv!.total).toBe(3697.5); // the agreed selection total — NOT 5437.5
    expect(inv!.deposit_applied).toBe(1848.75);
    expect(inv!.balance).toBe(1848.75); // 3697.5 − 1848.75, not the inflated 3588.75
  });

  // W1-001: an amendment's new_total supersedes the snapshot selection total.
  it('bills the latest amendment new_total when the trail has one', async () => {
    const amended = {
      id: 'q1',
      result: { total: 5437.5 },
      approval_snapshot: {
        customerSelection: { currentTotalUsd: 3697.5 },
        amendments: [{ new_total: 4100 }],
      },
      deposit_amount_usd: 1848.75,
      deposit_paid_at: '2025-01-01T00:00:00Z',
    };
    const fake = makeFakeSupabase({ jobs: [{ id: 'j1', quote_id: 'q1', customer_id: 'c1' }], quotes: [amended] });
    sbRef.current = fake.client;

    const inv = await createInvoiceFromJob('j1');
    expect(inv!.total).toBe(4100); // amendment new_total wins
    expect(inv!.balance).toBe(2251.25); // 4100 − 1848.75
  });

  // W1-001: a legacy row with NO approval_snapshot must keep pricing off
  // result.total (the pre-fix behavior — the fallback rung).
  it('keeps the legacy result.total path when there is no approval_snapshot', async () => {
    const fake = makeFakeSupabase({ jobs: [{ id: 'j1', quote_id: 'q1', customer_id: 'c1' }], quotes: [quote] });
    sbRef.current = fake.client;
    const inv = await createInvoiceFromJob('j1');
    expect(inv!.total).toBe(4893.75); // result.total, unchanged
    expect(inv!.balance).toBe(2446.87);
  });
});

// ─── DB: setInvoiceStatus ───────────────────────────────────────────────────

describe('setInvoiceStatus', () => {
  it('stamps paid_at on paid and persists the status', async () => {
    const fake = makeFakeSupabase({ invoices: [{ id: 'i1', status: 'awaiting_payment', paid_at: null }] });
    sbRef.current = fake.client;
    const inv = await setInvoiceStatus('i1', 'paid');
    expect(inv!.status).toBe('paid');
    expect(inv!.paid_at).toBeTruthy();
  });

  it('throws on an illegal transition', async () => {
    const fake = makeFakeSupabase({ invoices: [{ id: 'i1', status: 'paid', paid_at: 'x' }] });
    sbRef.current = fake.client;
    await expect(setInvoiceStatus('i1', 'draft')).rejects.toThrow(/illegal transition/);
  });

  // W1-023: optimistic lock — the UPDATE carries `.eq('status', current.status)`.
  // A concurrent transition (e.g. an order-cancel flipping the invoice to cancelled)
  // that lands between the read and this write matches 0 rows; we must NOT write the
  // requested status over the winner's. A divergent race returns null (lost race).
  it('does NOT write over a concurrently-changed status (compare-and-swap)', async () => {
    const staleRead = { id: 'i1', status: 'awaiting_payment', paid_at: null };
    const liveRow = { id: 'i1', status: 'cancelled', paid_at: null };
    let statusGuard: unknown = undefined;
    let updatePatch: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      from: () => builder,
      select: () => builder,
      update: (patch: Record<string, unknown>) => {
        updatePatch = patch;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        if (col === 'status') statusGuard = val;
        return builder;
      },
      maybeSingle: async () => ({ data: staleRead, error: null }),
      single: async () => {
        if (statusGuard !== undefined && statusGuard !== liveRow.status) {
          return { data: null, error: { message: 'no rows' } };
        }
        return { data: { ...liveRow, ...updatePatch }, error: null };
      },
    };
    sbRef.current = builder;
    // awaiting_payment → paid is legal by the transition table; the compare-and-swap
    // against the LIVE (cancelled) row fails → 0 rows → null, never a false 'paid'.
    const result = await setInvoiceStatus('i1', 'paid');
    expect(statusGuard).toBe('awaiting_payment'); // guarded on the read status
    expect(result).toBeNull();
  });
});

// ─── reads / unconfigured ───────────────────────────────────────────────────

describe('getInvoiceByJob', () => {
  it('returns null safely when Supabase is unconfigured', async () => {
    sbRef.current = null;
    expect(await getInvoiceByJob('j1')).toBeNull();
  });
});

describe('getInvoiceByQuote', () => {
  it('finds the one invoice linked to a quote', async () => {
    const fake = makeFakeSupabase({
      invoices: [
        { id: 'i1', invoice_number: 1000, job_id: 'j1', quote_id: 'q1', total: 1000, deposit_applied: 500, balance: 500, credit_note: 0, status: 'draft', created_at: '2026-06-02', paid_at: null },
      ],
    });
    sbRef.current = fake.client;
    const inv = await getInvoiceByQuote('q1');
    expect(inv?.id).toBe('i1');
  });

  it('returns null when the quote has no invoice yet', async () => {
    const fake = makeFakeSupabase({ invoices: [] });
    sbRef.current = fake.client;
    expect(await getInvoiceByQuote('q-none')).toBeNull();
  });

  it('returns null safely when Supabase is unconfigured', async () => {
    sbRef.current = null;
    expect(await getInvoiceByQuote('q1')).toBeNull();
  });
});

describe('listInvoicesForAdmin', () => {
  it('joins customer + is_test from the linked quote (newest first)', async () => {
    const fake = makeFakeSupabase({
      invoices: [
        { id: 'i1', invoice_number: 1000, job_id: 'j1', quote_id: 'q1', total: 1000, deposit_applied: 500, balance: 500, credit_note: 0, status: 'draft', created_at: '2026-06-02', paid_at: null },
        { id: 'i2', invoice_number: 1001, job_id: 'j2', quote_id: 'q2', total: 2000, deposit_applied: 1000, balance: 0, credit_note: 0, status: 'paid', created_at: '2026-06-01', paid_at: '2026-06-03' },
      ],
      quotes: [
        { id: 'q1', customer_name: 'Alice', customer_address: '1 Main St', is_test: false },
        { id: 'q2', customer_name: 'Test Bob', customer_address: '2 Oak', is_test: true },
      ],
    });
    sbRef.current = fake.client;

    const cards = await listInvoicesForAdmin();
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ id: 'i1', customerName: 'Alice', isTest: false, balance: 500, status: 'draft' });
    expect(cards[1]).toMatchObject({ id: 'i2', customerName: 'Test Bob', isTest: true, status: 'paid' });
  });

  it('returns [] when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await listInvoicesForAdmin()).toEqual([]);
  });

  it('computes the customer-detail route id fields (highlevel_contact_id first, then the invoice\'s own customer_id over the quote\'s)', async () => {
    const fake = makeFakeSupabase({
      invoices: [
        { id: 'i1', invoice_number: 1000, job_id: 'j1', quote_id: 'q1', customer_id: null, total: 1000, deposit_applied: 500, balance: 500, credit_note: 0, status: 'draft', created_at: '2026-06-02', paid_at: null },
        { id: 'i2', invoice_number: 1001, job_id: 'j2', quote_id: 'q2', customer_id: 'inv-cust-2', total: 2000, deposit_applied: 1000, balance: 0, credit_note: 0, status: 'paid', created_at: '2026-06-01', paid_at: '2026-06-03' },
      ],
      quotes: [
        { id: 'q1', customer_name: 'Alice', customer_address: '1 Main St', is_test: false, highlevel_contact_id: 'hl-1', customer_id: 'quote-cust-1' },
        { id: 'q2', customer_name: 'Bob', customer_address: '2 Oak', is_test: false, highlevel_contact_id: null, customer_id: 'quote-cust-2' },
      ],
    });
    sbRef.current = fake.client;

    const cards = await listInvoicesForAdmin();
    // i1: no invoice.customer_id, but the quote has a highlevel_contact_id — wins.
    expect(cards[0]).toMatchObject({ id: 'i1', highlevelContactId: 'hl-1', customerId: 'quote-cust-1' });
    // i2: no highlevel_contact_id on the quote — the invoice's OWN customer_id
    // ('inv-cust-2') is preferred over the quote's ('quote-cust-2').
    expect(cards[1]).toMatchObject({ id: 'i2', highlevelContactId: null, customerId: 'inv-cust-2' });
  });

  // #199: is_nce joins the SAME way is_test does above — feeds the NceBadge.
  it('joins is_nce from the linked quote', async () => {
    const fake = makeFakeSupabase({
      invoices: [
        { id: 'i1', invoice_number: 1000, job_id: 'j1', quote_id: 'q1', total: 1000, deposit_applied: 500, balance: 500, credit_note: 0, status: 'draft', created_at: '2026-06-02', paid_at: null },
        { id: 'i2', invoice_number: 1001, job_id: 'j2', quote_id: 'q2', total: 2000, deposit_applied: 1000, balance: 0, credit_note: 0, status: 'paid', created_at: '2026-06-01', paid_at: '2026-06-03' },
      ],
      quotes: [
        { id: 'q1', customer_name: 'Alice', is_test: false, is_nce: true },
        { id: 'q2', customer_name: 'Bob', is_test: false, is_nce: false },
      ],
    });
    sbRef.current = fake.client;

    const cards = await listInvoicesForAdmin();
    expect(cards[0]).toMatchObject({ id: 'i1', isNce: true });
    expect(cards[1]).toMatchObject({ id: 'i2', isNce: false });
  });

  it('defaults isNce to false when the invoice has no linked quote', async () => {
    const fake = makeFakeSupabase({
      invoices: [{ id: 'i1', invoice_number: 1000, job_id: null, quote_id: null, total: 1000, deposit_applied: 0, balance: 1000, credit_note: 0, status: 'draft', created_at: '2026-06-02', paid_at: null }],
    });
    sbRef.current = fake.client;
    const cards = await listInvoicesForAdmin();
    expect(cards[0].isNce).toBe(false);
  });
});

describe('setInvoiceTaxOverride', () => {
  const quote = {
    id: 'q1',
    result: { subtotalBeforeDiscount: 4500, discountAmount: 0, taxAmount: 393.75, total: 4893.75 },
  };

  it('drops the tax line + reprices the balance when overridden ON', async () => {
    const fake = makeFakeSupabase({
      invoices: [
        { id: 'i1', quote_id: 'q1', deposit_applied: 2446.88, subtotal: 4500, discount: 0, tax: 393.75, total: 4893.75, balance: 2446.87, credit_note: 0, status: 'draft', tax_overridden: false },
      ],
      quotes: [quote],
    });
    sbRef.current = fake.client;
    const inv = await setInvoiceTaxOverride('i1', true);
    expect(inv!.tax).toBe(0);
    expect(inv!.total).toBe(4500);
    expect(inv!.balance).toBe(2053.12);
    expect(inv!.tax_overridden).toBe(true);
  });

  it('restores tax from the source quote.result when toggled OFF', async () => {
    const fake = makeFakeSupabase({
      invoices: [
        { id: 'i1', quote_id: 'q1', deposit_applied: 2446.88, subtotal: 4500, discount: 0, tax: 0, total: 4500, balance: 2053.12, credit_note: 0, status: 'draft', tax_overridden: true },
      ],
      quotes: [quote],
    });
    sbRef.current = fake.client;
    const inv = await setInvoiceTaxOverride('i1', false);
    expect(inv!.tax).toBe(393.75);
    expect(inv!.total).toBe(4893.75);
    expect(inv!.balance).toBe(2446.87);
    expect(inv!.tax_overridden).toBe(false);
  });

  it('returns null when the invoice is missing', async () => {
    const fake = makeFakeSupabase({ invoices: [] });
    sbRef.current = fake.client;
    expect(await setInvoiceTaxOverride('nope', true)).toBeNull();
  });

  // B3 fix: a PAID invoice must never be re-opened by a tax-override change.
  // Collecting the balance already settled the debt — re-pricing cannot resurrect it.
  it('throws a 409-style error when the invoice is already paid (no resurrection)', async () => {
    const fake = makeFakeSupabase({
      invoices: [
        {
          id: 'i1',
          quote_id: 'q1',
          deposit_applied: 2446.88,
          subtotal: 4500,
          discount: 0,
          tax: 393.75,
          total: 4893.75,
          balance: 0,
          credit_note: 0,
          status: 'paid',
          tax_overridden: false,
          paid_at: '2026-06-01T12:00:00Z',
        },
      ],
      quotes: [quote],
    });
    sbRef.current = fake.client;
    await expect(setInvoiceTaxOverride('i1', true)).rejects.toThrow(/paid/i);
    // The invoice must not be touched — status and paid_at stay unchanged.
    expect(fake.tables.invoices[0]).toMatchObject({ status: 'paid', paid_at: '2026-06-01T12:00:00Z' });
  });

  // HIGH audit finding: setInvoiceTaxOverride's final write had no status
  // compare-and-swap. A Valor balance settlement landing between the initial
  // read and the final UPDATE (e.g. the invoice goes 'awaiting_payment' →
  // 'paid' while the quote lookup is in flight) must not be clobbered — the
  // write must be a CAS on the freshly-read status, mirroring
  // setInvoiceStatus's `.eq('status', current.status)` pattern. A settled
  // invoice must never be resurrected to awaiting_payment with a phantom
  // positive balance.
  it('does not resurrect a paid invoice raced by a concurrent settlement (CAS)', async () => {
    const fake = makeFakeSupabase({
      invoices: [
        { id: 'i1', quote_id: 'q1', deposit_applied: 2446.88, subtotal: 4500, discount: 0, tax: 393.75, total: 4893.75, balance: 2446.87, credit_note: 0, status: 'awaiting_payment', tax_overridden: false },
      ],
      quotes: [quote],
    });
    // Simulate a concurrent Valor balance settlement landing between
    // setInvoiceTaxOverride's initial getInvoice() read and its final UPDATE:
    // as soon as the source-quote lookup runs (the step right after the
    // read), flip the invoice to paid/balance-0/paid_at. REPLACE (not mutate)
    // the row object so the earlier read stays a frozen snapshot — matching
    // a real Supabase client, where every response is an independent
    // deserialized copy, never a live reference into the DB's row.
    const realFrom = fake.client.from;
    fake.client.from = (table: string) => {
      if (table === 'quotes') {
        fake.tables.invoices[0] = {
          ...fake.tables.invoices[0],
          status: 'paid',
          balance: 0,
          paid_at: '2026-07-07T00:00:00Z',
        };
      }
      return realFrom(table);
    };
    sbRef.current = fake.client;

    const result = await setInvoiceTaxOverride('i1', true);

    expect(result).toBeNull();
    // The concurrently-settled invoice must be left untouched by the raced
    // tax-override write — no resurrection to awaiting_payment, no phantom balance.
    expect(fake.tables.invoices[0]).toMatchObject({
      status: 'paid',
      balance: 0,
      paid_at: '2026-07-07T00:00:00Z',
    });
  });

  it('still works normally for a draft invoice (no regression)', async () => {
    const fake = makeFakeSupabase({
      invoices: [
        { id: 'i1', quote_id: 'q1', deposit_applied: 2446.88, subtotal: 4500, discount: 0, tax: 393.75, total: 4893.75, balance: 2446.87, credit_note: 0, status: 'draft', tax_overridden: false },
      ],
      quotes: [quote],
    });
    sbRef.current = fake.client;
    const inv = await setInvoiceTaxOverride('i1', true);
    expect(inv!.status).toBe('draft');
    expect(inv!.tax).toBe(0);
  });

  it('still works normally for an awaiting_payment invoice (no regression)', async () => {
    const fake = makeFakeSupabase({
      invoices: [
        { id: 'i1', quote_id: 'q1', deposit_applied: 2446.88, subtotal: 4500, discount: 0, tax: 393.75, total: 4893.75, balance: 2446.87, credit_note: 0, status: 'awaiting_payment', tax_overridden: false },
      ],
      quotes: [quote],
    });
    sbRef.current = fake.client;
    const inv = await setInvoiceTaxOverride('i1', true);
    // Exemption zeroes tax — deposit now > total, so it should settle to paid
    // OR if balance is still positive it stays awaiting_payment.
    // Here: total = 4500, deposit = 2446.88, balance = 2053.12 → still awaiting.
    expect(inv!.tax).toBe(0);
    expect(inv!.status).toBe('awaiting_payment');
  });

  // W1-001: the re-price must use the AGREED total (snapshot selection), not the
  // full quote.result.total — otherwise toggling the override silently re-bills
  // the whole quote for a diverged selection.
  it('re-prices from the AGREED selection total when the snapshot diverges', async () => {
    const divergedQuote = {
      id: 'q1',
      result: { subtotalBeforeDiscount: 4500, discountAmount: 0, taxAmount: 393.75, total: 4893.75 },
      approval_snapshot: { customerSelection: { currentTotalUsd: 3000 } },
    };
    const fake = makeFakeSupabase({
      invoices: [
        { id: 'i1', quote_id: 'q1', deposit_applied: 1500, subtotal: 4500, discount: 0, tax: 393.75, total: 3000, balance: 1500, credit_note: 0, status: 'draft', tax_overridden: false },
      ],
      quotes: [divergedQuote],
    });
    sbRef.current = fake.client;
    const inv = await setInvoiceTaxOverride('i1', true);
    // W1-001 + partial-selection tax fix: the exemption removes only the tax
    // EMBEDDED in the agreed $3,000 selection (3000 / 1.0875 → $241.38 tax), not the
    // full-quote tax of $393.75. So total = 3000 − 241.38 = 2758.62. Subtracting the
    // full-quote tax (the old behavior) would under-bill to 2606.25. NOT 4500.
    expect(inv!.total).toBe(2758.62);
    expect(inv!.tax).toBe(0);
    expect(inv!.balance).toBe(1258.62); // 2758.62 − 1500
  });

  // FIX #7: there is no safe fallback to the invoice's own stored tax/total when
  // the source quote's priced result can't be read — those stored fields can
  // already be a mismatched basis (e.g. the amend re-sync writes the quote's
  // FULL-quote tax against an amended, PARTIAL total). Blindly subtracting that
  // full tax from the partial total would under-bill, so this must refuse instead.
  it('refuses the override when the linked quote has no priced result (no under-bill)', async () => {
    const fake = makeFakeSupabase({
      invoices: [
        {
          id: 'i1',
          quote_id: 'q1',
          deposit_applied: 1500,
          subtotal: 4500,
          discount: 0,
          tax: 393.75, // the FULL-quote tax
          total: 3000, // a PARTIAL total — mismatched basis vs. `tax`
          balance: 1500,
          credit_note: 0,
          status: 'draft',
          tax_overridden: false,
        },
      ],
      quotes: [{ id: 'q1', result: null }], // linked quote exists but its result is gone
    });
    sbRef.current = fake.client;
    await expect(setInvoiceTaxOverride('i1', true)).rejects.toThrow(/priced result is unavailable/i);
    // Refused — the invoice must be untouched, not silently under-billed.
    expect(fake.tables.invoices[0]).toMatchObject({ tax: 393.75, total: 3000, tax_overridden: false });
  });

  it('refuses the override when the invoice has no linked quote at all', async () => {
    const fake = makeFakeSupabase({
      invoices: [
        {
          id: 'i1',
          quote_id: null,
          deposit_applied: 1500,
          subtotal: 4500,
          discount: 0,
          tax: 393.75,
          total: 3000,
          balance: 1500,
          credit_note: 0,
          status: 'draft',
          tax_overridden: false,
        },
      ],
      quotes: [],
    });
    sbRef.current = fake.client;
    await expect(setInvoiceTaxOverride('i1', true)).rejects.toThrow(/priced result is unavailable/i);
  });
});

describe('getInvoiceDetail', () => {
  it('returns the invoice + joined customer + linked job number/status', async () => {
    const fake = makeFakeSupabase({
      invoices: [{ id: 'i1', job_id: 'j1', quote_id: 'q1', total: 1000, balance: 500, status: 'draft' }],
      quotes: [{ id: 'q1', customer_name: 'Alice', customer_email: 'a@x.com', customer_phone: '555-0100', customer_address: '1 Main St', is_test: false }],
      jobs: [{ id: 'j1', job_number: 1000, status: 'requires_invoicing' }],
    });
    sbRef.current = fake.client;

    const d = await getInvoiceDetail('i1');
    expect(d).toMatchObject({
      invoice: { id: 'i1' },
      customerName: 'Alice',
      customerEmail: 'a@x.com',
      isTest: false,
      jobNumber: 1000,
      jobStatus: 'requires_invoicing',
    });
  });

  // #177 fix 4: the linked quote's stamped deposit_amount_usd is threaded through
  // as intendedDepositUsd, so the admin detail page can pass it to reconcileInvoice.
  it('surfaces the linked quote\'s deposit_amount_usd as intendedDepositUsd', async () => {
    const fake = makeFakeSupabase({
      invoices: [{ id: 'i1', job_id: null, quote_id: 'q1', total: 4000, balance: 3200, status: 'draft' }],
      quotes: [{ id: 'q1', customer_name: 'Alice', is_test: false, deposit_amount_usd: 800 }],
    });
    sbRef.current = fake.client;

    const d = await getInvoiceDetail('i1');
    expect(d?.intendedDepositUsd).toBe(800);
  });

  it('intendedDepositUsd is null when the invoice has no linked quote', async () => {
    const fake = makeFakeSupabase({
      invoices: [{ id: 'i1', job_id: null, quote_id: null, total: 4000, balance: 3200, status: 'draft' }],
    });
    sbRef.current = fake.client;

    const d = await getInvoiceDetail('i1');
    expect(d?.intendedDepositUsd).toBeNull();
  });

  // #199: is_nce joins the same way is_test does — gates the charge/send-
  // balance-link UI and the "Mark paid — NCE" affordance on the detail page.
  it('surfaces the linked quote\'s is_nce', async () => {
    const fake = makeFakeSupabase({
      invoices: [{ id: 'i1', job_id: null, quote_id: 'q1', total: 4000, balance: 3200, status: 'draft' }],
      quotes: [{ id: 'q1', customer_name: 'Alice', is_test: false, is_nce: true }],
    });
    sbRef.current = fake.client;

    const d = await getInvoiceDetail('i1');
    expect(d?.isNce).toBe(true);
  });

  it('defaults isNce to false when the invoice has no linked quote', async () => {
    const fake = makeFakeSupabase({
      invoices: [{ id: 'i1', job_id: null, quote_id: null, total: 4000, balance: 3200, status: 'draft' }],
    });
    sbRef.current = fake.client;

    const d = await getInvoiceDetail('i1');
    expect(d?.isNce).toBe(false);
  });

  it('returns null when the invoice is missing', async () => {
    const fake = makeFakeSupabase({ invoices: [] });
    sbRef.current = fake.client;
    expect(await getInvoiceDetail('nope')).toBeNull();
  });

  it('returns null when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await getInvoiceDetail('i1')).toBeNull();
  });
});

// ─── DB: markInvoicePaidManually ────────────────────────────────────────────

describe('markInvoicePaidManually', () => {
  it('marks an awaiting_payment invoice paid, zeroes balance, stamps paid_at', async () => {
    const fake = makeFakeSupabase({
      invoices: [{ id: 'i1', status: 'awaiting_payment', balance: 500, paid_at: null }],
    });
    sbRef.current = fake.client;

    const inv = await markInvoicePaidManually('i1');
    expect(inv).toBeTruthy();
    expect(inv!.status).toBe('paid');
    expect(inv!.balance).toBe(0);
    expect(inv!.paid_at).toBeTruthy();
  });

  it('is idempotent — a paid invoice is returned as-is with no write', async () => {
    const fake = makeFakeSupabase({
      invoices: [{ id: 'i1', status: 'paid', balance: 0, paid_at: '2026-01-01T00:00:00Z' }],
    });
    sbRef.current = fake.client;
    const updateSpy = vi.spyOn(fake.client, 'from');

    const inv = await markInvoicePaidManually('i1');
    expect(inv!.status).toBe('paid');
    // We can't easily spy on the update call depth, but we can verify the
    // returned invoice is exactly the existing one (no new paid_at).
    expect(inv!.paid_at).toBe('2026-01-01T00:00:00Z');
    updateSpy.mockRestore();
  });

  it('throws when the invoice is cancelled', async () => {
    const fake = makeFakeSupabase({
      invoices: [{ id: 'i1', status: 'cancelled', balance: 500, paid_at: null }],
    });
    sbRef.current = fake.client;
    await expect(markInvoicePaidManually('i1')).rejects.toThrow(/cancelled/);
  });

  // W1-022: TOCTOU — the pre-check read saw awaiting_payment (throw skipped) but
  // the row has since been cancelled by a concurrent order-cancel. The atomic
  // claim must NOT resurrect the cancelled invoice to paid. Simulated with a
  // builder whose getInvoice read returns the STALE awaiting_payment snapshot
  // while the guarded write matches against the LIVE (cancelled) row → 0 rows.
  it('does NOT resurrect a concurrently-cancelled invoice to paid (atomic guard)', async () => {
    const staleRead = { id: 'i1', status: 'awaiting_payment', balance: 500, paid_at: null };
    const liveRow = { id: 'i1', status: 'cancelled', balance: 500, paid_at: null };
    let sawUpdate = false;
    let updatePatch: Record<string, unknown> = {};
    const statusNeqPreds: Array<(s: string) => boolean> = [];
    const builder: Record<string, unknown> = {
      from: () => builder,
      select: () => builder,
      update: (patch: Record<string, unknown>) => {
        sawUpdate = true;
        updatePatch = patch;
        return builder;
      },
      eq: () => builder,
      neq: (col: string, val: unknown) => {
        if (col === 'status') statusNeqPreds.push((s) => s !== val);
        return builder;
      },
      // getInvoice pre-check reads the STALE snapshot.
      maybeSingle: async () => ({ data: staleRead, error: null }),
      // The claim uses .select(...) without .single() → resolves via then() to an
      // array. Honor the collected .neq('status',…) guards against the LIVE row;
      // a matched row returns the row WITH the update patch applied (as the real
      // DB does), so a buggy guard would surface status:'paid'.
      then: (resolve: (v: unknown) => void) => {
        const matched = statusNeqPreds.every((p) => p(liveRow.status as string))
          ? [{ ...liveRow, ...updatePatch }]
          : [];
        resolve({ data: matched, error: null });
      },
    };
    sbRef.current = builder;
    const result = await markInvoicePaidManually('i1');
    expect(sawUpdate).toBe(true);
    // 0 rows through the guard → the invoice was never written to 'paid'.
    expect(result?.status).not.toBe('paid');
  });

  it('returns null when the invoice does not exist', async () => {
    const fake = makeFakeSupabase({ invoices: [] });
    sbRef.current = fake.client;
    expect(await markInvoicePaidManually('nope')).toBeNull();
  });

  // #199: method/reference params — every EXISTING caller (no args) keeps
  // getting exactly what it always got (no method/reference concept existed
  // before), now just also labelled 'cash_check'/null.
  describe('#199 method/reference', () => {
    it('defaults to cash_check with a null reference when called with no method/reference (back-compat)', async () => {
      const fake = makeFakeSupabase({
        invoices: [{ id: 'i1', status: 'awaiting_payment', balance: 500, paid_at: null }],
      });
      sbRef.current = fake.client;
      const inv = await markInvoicePaidManually('i1');
      expect(inv!.paid_method).toBe('cash_check');
      expect(inv!.payment_reference ?? null).toBeNull();
    });

    it('writes method + a trimmed-by-caller reference when passed', async () => {
      const fake = makeFakeSupabase({
        invoices: [{ id: 'i1', status: 'awaiting_payment', balance: 500, paid_at: null }],
      });
      sbRef.current = fake.client;
      const inv = await markInvoicePaidManually('i1', 'nce', 'NCE-4821');
      expect(inv!.paid_method).toBe('nce');
      expect(inv!.payment_reference).toBe('NCE-4821');
    });

    it('an idempotent already-paid call returns the EXISTING method/reference, ignoring this call\'s params', async () => {
      const fake = makeFakeSupabase({
        invoices: [
          {
            id: 'i1',
            status: 'paid',
            balance: 0,
            paid_at: '2026-01-01T00:00:00Z',
            paid_method: 'nce',
            payment_reference: 'NCE-1',
          },
        ],
      });
      sbRef.current = fake.client;
      const inv = await markInvoicePaidManually('i1', 'cash_check', null);
      expect(inv!.paid_method).toBe('nce');
      expect(inv!.payment_reference).toBe('NCE-1');
    });

    // #199 (wrap-review LOW, accepted-narrow): the idempotent-return race —
    // a concurrent settle wins, this call's params are discarded — still
    // returns the existing row unchanged (never overwrites a real
    // settlement), but now leaves a cheap, honest trace when what's stored
    // doesn't match what THIS call asked for.
    it('warns (but still returns the existing row unchanged) when a concurrent settle won with a DIFFERENT method/reference', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fake = makeFakeSupabase({
        invoices: [
          { id: 'i1', status: 'paid', balance: 0, paid_at: '2026-01-01T00:00:00Z', paid_method: 'cash_check', payment_reference: null },
        ],
      });
      sbRef.current = fake.client;
      const inv = await markInvoicePaidManually('i1', 'nce', 'NCE-9');
      expect(inv!.paid_method).toBe('cash_check'); // the earlier settle wins
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('already settled'));
      warnSpy.mockRestore();
    });

    it('does not warn when the idempotent return already matches what this call asked for', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fake = makeFakeSupabase({
        invoices: [
          { id: 'i1', status: 'paid', balance: 0, paid_at: '2026-01-01T00:00:00Z', paid_method: 'nce', payment_reference: 'NCE-1' },
        ],
      });
      sbRef.current = fake.client;
      await markInvoicePaidManually('i1', 'nce', 'NCE-1');
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  // #199 F2 (wrap-review HIGH): a single positive gate covering BOTH real
  // call sites (job-close's bare force-settle; the mark-paid route, itself
  // reachable from PipelineActionsMenu's generic "collect-payment" empty-body
  // POST) — an NCE-linked invoice can only ever settle as method:'nce'.
  describe('#199 F2 — NCE settle-method gate', () => {
    it('throws InvoiceSettleError(nce-mismatch) for a cash_check settle on an NCE-linked invoice', async () => {
      const fake = makeFakeSupabase({
        invoices: [{ id: 'i1', quote_id: 'q1', status: 'awaiting_payment', balance: 500, paid_at: null }],
        quotes: [{ id: 'q1', is_nce: true }],
      });
      sbRef.current = fake.client;
      await expect(markInvoicePaidManually('i1')).rejects.toThrow(InvoiceSettleError);
      await expect(markInvoicePaidManually('i1')).rejects.toMatchObject({ code: 'nce-mismatch' });
    });

    it('throws for the SAME reason when method is omitted entirely (the bare job-close call shape)', async () => {
      const fake = makeFakeSupabase({
        invoices: [{ id: 'i1', quote_id: 'q1', status: 'awaiting_payment', balance: 500, paid_at: null }],
        quotes: [{ id: 'q1', is_nce: true }],
      });
      sbRef.current = fake.client;
      await expect(markInvoicePaidManually('i1')).rejects.toThrow(/is NCE/);
    });

    it('does NOT settle (no write) when it refuses — the invoice stays unpaid', async () => {
      const fake = makeFakeSupabase({
        invoices: [{ id: 'i1', quote_id: 'q1', status: 'awaiting_payment', balance: 500, paid_at: null }],
        quotes: [{ id: 'q1', is_nce: true }],
      });
      sbRef.current = fake.client;
      await expect(markInvoicePaidManually('i1')).rejects.toThrow();
      const inv = fake.tables.invoices.find((i) => i.id === 'i1')!;
      expect(inv.status).toBe('awaiting_payment');
    });

    it('allows method:"nce" on an NCE-linked invoice', async () => {
      const fake = makeFakeSupabase({
        invoices: [{ id: 'i1', quote_id: 'q1', status: 'awaiting_payment', balance: 500, paid_at: null }],
        quotes: [{ id: 'q1', is_nce: true }],
      });
      sbRef.current = fake.client;
      const inv = await markInvoicePaidManually('i1', 'nce', 'NCE-1');
      expect(inv!.status).toBe('paid');
      expect(inv!.paid_method).toBe('nce');
    });

    it('allows a cash_check settle on a NON-NCE invoice (unaffected)', async () => {
      const fake = makeFakeSupabase({
        invoices: [{ id: 'i1', quote_id: 'q1', status: 'awaiting_payment', balance: 500, paid_at: null }],
        quotes: [{ id: 'q1', is_nce: false }],
      });
      sbRef.current = fake.client;
      const inv = await markInvoicePaidManually('i1');
      expect(inv!.status).toBe('paid');
      expect(inv!.paid_method).toBe('cash_check');
    });

    it('allows a cash_check settle when the invoice has no linked quote (nothing to check)', async () => {
      const fake = makeFakeSupabase({
        invoices: [{ id: 'i1', quote_id: null, status: 'awaiting_payment', balance: 500, paid_at: null }],
      });
      sbRef.current = fake.client;
      const inv = await markInvoicePaidManually('i1');
      expect(inv!.status).toBe('paid');
    });
  });

  // #199 delta-verify (MED): the is_nce read can fail on its own (a transient
  // network blip / RLS hiccup) independent of what it would have found. The
  // first cut discarded that error, so `quoteRow` came back null and the
  // settle sailed through as if the quote were confirmed non-NCE — wrongly
  // ALLOWING is unrecoverable (see markInvoicePaidManually's own doc
  // comment), so this proves the fix now FAILS CLOSED instead.
  describe('#199 delta-verify — fails closed when the is_nce read errors', () => {
    it('throws InvoiceSettleError(nce-check-failed) and does NOT settle when the quotes read errors', async () => {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const fake = makeFakeSupabase({
        invoices: [{ id: 'i1', quote_id: 'q1', status: 'awaiting_payment', balance: 500, paid_at: null }],
      });
      // A local wrapper: every table but `quotes` delegates straight to the
      // real fake; `quotes` simulates a transient read error instead of a
      // normal maybeSingle() resolution. makeFakeSupabase has no error
      // injection — deliberately not retrofitting that in for one test, many
      // other tests depend on its current all-success behavior.
      const erroringClient = {
        from(table: string) {
          if (table !== 'quotes') return fake.client.from(table);
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: null, error: { message: 'connection reset' } }),
              }),
            }),
          };
        },
        rpc: fake.client.rpc,
      };
      sbRef.current = erroringClient;

      await expect(markInvoicePaidManually('i1')).rejects.toThrow(InvoiceSettleError);
      await expect(markInvoicePaidManually('i1')).rejects.toMatchObject({ code: 'nce-check-failed' });

      const inv = fake.tables.invoices.find((i) => i.id === 'i1')!;
      expect(inv.status).toBe('awaiting_payment');
      expect(inv.paid_at).toBeNull();
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });
});

// ─── DB: updateInvoicePaymentReference ──────────────────────────────────────

describe('updateInvoicePaymentReference (#199)', () => {
  it('updates the reference on an already-paid NCE invoice', async () => {
    const fake = makeFakeSupabase({
      invoices: [{ id: 'i1', status: 'paid', balance: 0, paid_method: 'nce', payment_reference: 'NCE-OLD' }],
    });
    sbRef.current = fake.client;
    const inv = await updateInvoicePaymentReference('i1', 'NCE-NEW');
    expect(inv!.payment_reference).toBe('NCE-NEW');
  });

  it('trims whitespace off the reference before writing', async () => {
    const fake = makeFakeSupabase({
      invoices: [{ id: 'i1', status: 'paid', balance: 0, paid_method: 'nce', payment_reference: 'NCE-OLD' }],
    });
    sbRef.current = fake.client;
    const inv = await updateInvoicePaymentReference('i1', '  NCE-NEW  ');
    expect(inv!.payment_reference).toBe('NCE-NEW');
  });

  it('refuses (null) on a whitespace-only reference', async () => {
    const fake = makeFakeSupabase({
      invoices: [{ id: 'i1', status: 'paid', balance: 0, paid_method: 'nce', payment_reference: 'NCE-OLD' }],
    });
    sbRef.current = fake.client;
    expect(await updateInvoicePaymentReference('i1', '   ')).toBeNull();
  });

  it('refuses (null) when the invoice is not paid', async () => {
    const fake = makeFakeSupabase({
      invoices: [{ id: 'i1', status: 'awaiting_payment', balance: 500, paid_method: 'nce' }],
    });
    sbRef.current = fake.client;
    expect(await updateInvoicePaymentReference('i1', 'NCE-NEW')).toBeNull();
  });

  it('refuses (null) when the invoice was paid via cash/check, not NCE', async () => {
    const fake = makeFakeSupabase({
      invoices: [{ id: 'i1', status: 'paid', balance: 0, paid_method: 'cash_check' }],
    });
    sbRef.current = fake.client;
    expect(await updateInvoicePaymentReference('i1', 'NCE-NEW')).toBeNull();
  });

  it('returns null when the invoice does not exist', async () => {
    const fake = makeFakeSupabase({ invoices: [] });
    sbRef.current = fake.client;
    expect(await updateInvoicePaymentReference('nope', 'NCE-NEW')).toBeNull();
  });
});

// ─── Pure: reconcileInvoice ─────────────────────────────────────────────────
// Money-reconciliation at a glance for a non-developer operator: Quoted /
// Deposit received / Balance due + actionable flags (#83 Jobber verify).

function makeInvoiceRow(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: 'inv-1',
    invoice_number: 1,
    job_id: 'job-1',
    quote_id: 'quote-1',
    customer_id: 'cust-1',
    subtotal: 4000,
    discount: 0,
    tax: 0,
    total: 4000,
    deposit_applied: 2000,
    balance: 2000,
    credit_note: 0,
    tax_overridden: false,
    status: 'awaiting_payment',
    valor_balance_txn_id: null,
    valor_receipt_url: null,
    valor_txn_log: null,
    payment_preference: null,
    created_at: '2026-01-01T00:00:00Z',
    paid_at: null,
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('reconcileInvoice — core fields', () => {
  it('maps total → quoted, deposit_applied → depositApplied, balance → balanceDue', () => {
    const r = reconcileInvoice(makeInvoiceRow());
    expect(r.quoted).toBe(4000);
    expect(r.depositApplied).toBe(2000);
    expect(r.balanceDue).toBe(2000);
    expect(r.creditNote).toBe(0);
  });

  it('paid = true when status is "paid"', () => {
    const r = reconcileInvoice(makeInvoiceRow({ status: 'paid', balance: 0, paid_at: '2026-01-02T00:00:00Z' }));
    expect(r.paid).toBe(true);
  });

  it('paid = false for draft, awaiting_payment, cancelled', () => {
    expect(reconcileInvoice(makeInvoiceRow({ status: 'awaiting_payment' })).paid).toBe(false);
    expect(reconcileInvoice(makeInvoiceRow({ status: 'draft' })).paid).toBe(false);
    expect(reconcileInvoice(makeInvoiceRow({ status: 'cancelled' })).paid).toBe(false);
  });
});

describe('reconcileInvoice — flags', () => {
  it('no flags on a clean invoice (deposit ≥ 40% of total, no balance issue)', () => {
    // deposit = $2000 on $4000 (50%) — above threshold, awaiting_payment has balance-outstanding
    // but let's use status=paid with balance=0 to get truly clean
    const r = reconcileInvoice(makeInvoiceRow({ status: 'paid', balance: 0, deposit_applied: 2000, credit_note: 0 }));
    expect(r.flags).toEqual([]);
  });

  it('no flags when deposit is zero and invoice is draft (no deposit taken yet)', () => {
    // deposit_applied = 0 → NOT a short-deposit (deposit was never attempted)
    const r = reconcileInvoice(makeInvoiceRow({ status: 'draft', deposit_applied: 0, balance: 4000, credit_note: 0 }));
    // balance-outstanding fires because !paid && balance > 0
    expect(r.flags).toContain('balance-outstanding');
    expect(r.flags).not.toContain('short-deposit');
  });

  it('overpaid: credit_note > 0 → "overpaid" flag', () => {
    const r = reconcileInvoice(
      makeInvoiceRow({ total: 3000, deposit_applied: 4000, balance: 0, credit_note: 1000 }),
    );
    expect(r.flags).toContain('overpaid');
  });

  it('short-deposit: deposit > 0 and deposit < 40% of quoted → "short-deposit" flag', () => {
    // $500 on $4000 = 12.5% → under 40%
    const r = reconcileInvoice(
      makeInvoiceRow({ total: 4000, deposit_applied: 500, balance: 3500, credit_note: 0 }),
    );
    expect(r.flags).toContain('short-deposit');
  });

  it('short-deposit: NOT flagged when deposit is exactly 40% of quoted', () => {
    // $1600 on $4000 = 40.0% — at threshold exactly, not under it
    const r = reconcileInvoice(
      makeInvoiceRow({ total: 4000, deposit_applied: 1600, balance: 2400, credit_note: 0 }),
    );
    expect(r.flags).not.toContain('short-deposit');
  });

  it('short-deposit: NOT flagged when deposit is 0 (no deposit taken yet)', () => {
    const r = reconcileInvoice(
      makeInvoiceRow({ total: 4000, deposit_applied: 0, balance: 4000, credit_note: 0 }),
    );
    expect(r.flags).not.toContain('short-deposit');
  });

  it('balance-outstanding: !paid && balanceDue > 0 → "balance-outstanding" flag', () => {
    const r = reconcileInvoice(makeInvoiceRow({ status: 'awaiting_payment', balance: 2000 }));
    expect(r.flags).toContain('balance-outstanding');
  });

  it('balance-outstanding: NOT flagged when invoice is paid', () => {
    const r = reconcileInvoice(makeInvoiceRow({ status: 'paid', balance: 0, credit_note: 0 }));
    expect(r.flags).not.toContain('balance-outstanding');
  });

  it('balance-outstanding: NOT flagged when balance is 0 (deposit covered it, not yet marked paid)', () => {
    const r = reconcileInvoice(makeInvoiceRow({ status: 'draft', balance: 0, credit_note: 0 }));
    expect(r.flags).not.toContain('balance-outstanding');
  });

  it('inconsistent: paid && balanceDue > 0 → "inconsistent" flag (data integrity error)', () => {
    const r = reconcileInvoice(
      makeInvoiceRow({ status: 'paid', balance: 500, credit_note: 0, paid_at: '2026-01-02T00:00:00Z' }),
    );
    expect(r.flags).toContain('inconsistent');
  });

  it('multiple flags: short-deposit + balance-outstanding can both fire', () => {
    const r = reconcileInvoice(
      makeInvoiceRow({
        total: 4000,
        deposit_applied: 300,
        balance: 3700,
        credit_note: 0,
        status: 'awaiting_payment',
      }),
    );
    expect(r.flags).toContain('short-deposit');
    expect(r.flags).toContain('balance-outstanding');
  });

  // WT-20: setInvoiceStatus never zeroes the balance on cancel, so a cancelled
  // invoice keeps its original nonzero balance. That's expected — the only real
  // follow-up on a cancelled order is a manual refund, not collection — so the
  // collection-oriented flags must NOT fire and falsely read as "still owed".
  it('cancelled: no balance-outstanding or short-deposit flags even with a nonzero balance', () => {
    const r = reconcileInvoice(
      makeInvoiceRow({ status: 'cancelled', total: 4000, deposit_applied: 500, balance: 3500, credit_note: 0 }),
    );
    expect(r.flags).not.toContain('balance-outstanding');
    expect(r.flags).not.toContain('short-deposit');
  });
});

// #177 fix 4: short-deposit against the quote's OWN intended deposit, not a
// blanket 50%-assumption threshold. The old "< 40% of quoted" heuristic
// false-alarmed any legit sub-40% per-quote deposit percent (a custom 20%
// deposit fully collected would read as "short" purely because 20% < 40%).
describe('reconcileInvoice — #177 per-quote deposit percent (intendedDepositUsd)', () => {
  it('a custom 20% deposit, fully collected, does NOT flag short-deposit', () => {
    // $800 on a $4000 total = 20% — well under the OLD blanket 40% threshold,
    // but this quote's OWN intended deposit (20%) was collected in full.
    const r = reconcileInvoice(
      makeInvoiceRow({ total: 4000, deposit_applied: 800, balance: 3200, credit_note: 0 }),
      800, // intendedDepositUsd — this quote's stamped 20% deposit
    );
    expect(r.flags).not.toContain('short-deposit');
  });

  it('genuinely short — only HALF the intended deposit applied — DOES flag', () => {
    // Intended $800 (this quote's own 20% deposit); only $400 (half) actually
    // applied. Short relative to what THIS quote actually agreed to, not to a
    // universal 40%/50% assumption.
    const r = reconcileInvoice(
      makeInvoiceRow({ total: 4000, deposit_applied: 400, balance: 3600, credit_note: 0 }),
      800,
    );
    expect(r.flags).toContain('short-deposit');
  });

  it('NOT flagged at exactly 80% of intended (tolerance boundary)', () => {
    const r = reconcileInvoice(
      makeInvoiceRow({ total: 4000, deposit_applied: 640, balance: 3360, credit_note: 0 }),
      800, // 640 / 800 = 80.0% exactly — at the tolerance, not under it
    );
    expect(r.flags).not.toContain('short-deposit');
  });

  it('falls back to the old 40%-of-quoted heuristic when intendedDepositUsd is unavailable (legacy)', () => {
    // No intendedDepositUsd argument — a legacy quote predating deposit_amount_usd.
    // $500 on $4000 = 12.5%, under the fallback's 40% threshold.
    const r = reconcileInvoice(makeInvoiceRow({ total: 4000, deposit_applied: 500, balance: 3500, credit_note: 0 }));
    expect(r.flags).toContain('short-deposit');
  });
});

// ─── appendRetiredTxn (#170b + #640 review MED: CAS'd log append) ───────────
// Bespoke chain fake (the shared in-memory fake doesn't model jsonb-equality
// filters): records every update's patch + filters and serves queued results.
describe('appendRetiredTxn', () => {
  type UpdateRec = { patch: Record<string, unknown>; filters: [string, string, unknown][] };
  function makeCasSb(
    invoice: Record<string, unknown>,
    updateResults: { data?: unknown[]; error?: unknown }[] = [],
  ) {
    let idx = 0;
    const updates: UpdateRec[] = [];
    const client = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: invoice, error: null }) }) }),
        update: (patch: Record<string, unknown>) => {
          const rec: UpdateRec = { patch, filters: [] };
          updates.push(rec);
          const chain = {
            eq: (c: string, v: unknown) => {
              rec.filters.push(['eq', c, v]);
              return chain;
            },
            is: (c: string, v: unknown) => {
              rec.filters.push(['is', c, v]);
              return chain;
            },
            select: async () => updateResults[idx++] ?? { data: [{ id: 'inv-1' }], error: null },
          };
          return chain;
        },
      }),
    };
    return { client, updates };
  }

  const ENTRY = {
    txnId: 'TXN-OLD-7',
    receiptUrl: 'https://valor/r/7',
    settledAt: '2026-06-15T10:00:00Z',
    retiredAt: '2026-07-24T10:00:00Z',
    reason: 'amend-reopen',
  };

  it('appends on the first try, CAS-guarded on a NULL prior log', async () => {
    const { client, updates } = makeCasSb({ id: 'inv-1', valor_txn_log: null, valor_balance_txn_id: 'TXN-OLD-7' });
    sbRef.current = client;
    expect(await appendRetiredTxn('inv-1', ENTRY)).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].patch.valor_txn_log).toEqual([ENTRY]);
    expect(updates[0].filters).toContainEqual(['is', 'valor_txn_log', null]);
  });

  it('retries after a lost CAS and succeeds on the second attempt', async () => {
    const { client, updates } = makeCasSb(
      { id: 'inv-1', valor_txn_log: [{ txnId: 'PRIOR' }], valor_balance_txn_id: null },
      [{ data: [] }, { data: [{ id: 'inv-1' }] }],
    );
    sbRef.current = client;
    expect(await appendRetiredTxn('inv-1', ENTRY)).toBe(true);
    expect(updates).toHaveLength(2);
    // Each attempt CAS'd on the log value it read.
    expect(updates[1].filters).toContainEqual(['eq', 'valor_txn_log', JSON.stringify([{ txnId: 'PRIOR' }])]);
    // The appended array preserves the prior entry (no lost update).
    expect(updates[1].patch.valor_txn_log).toEqual([{ txnId: 'PRIOR' }, ENTRY]);
  });

  it('gives up loudly (false) when the CAS never lands', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, updates } = makeCasSb({ id: 'inv-1', valor_txn_log: null, valor_balance_txn_id: null }, [
      { data: [] },
      { data: [] },
      { data: [] },
    ]);
    sbRef.current = client;
    expect(await appendRetiredTxn('inv-1', ENTRY)).toBe(false);
    expect(updates).toHaveLength(3);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('lost the CAS'), expect.anything());
    err.mockRestore();
  });

  it('clearLive: retires the live slot CAS-exact and bails when the live txn moved', async () => {
    const ok = makeCasSb({ id: 'inv-1', valor_txn_log: null, valor_balance_txn_id: 'TXN-OLD-7' });
    sbRef.current = ok.client;
    expect(await appendRetiredTxn('inv-1', ENTRY, { clearLive: { expectTxnId: 'TXN-OLD-7' } })).toBe(true);
    expect(ok.updates[0].patch).toMatchObject({ valor_balance_txn_id: null, valor_receipt_url: null });
    expect(ok.updates[0].filters).toContainEqual(['eq', 'valor_balance_txn_id', 'TXN-OLD-7']);

    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const moved = makeCasSb({ id: 'inv-1', valor_txn_log: null, valor_balance_txn_id: 'TXN-NEWER' });
    sbRef.current = moved.client;
    expect(await appendRetiredTxn('inv-1', ENTRY, { clearLive: { expectTxnId: 'TXN-OLD-7' } })).toBe(false);
    expect(moved.updates).toHaveLength(0); // bailed before writing anything
    err.mockRestore();
  });
});

// ─── mergeInvoicesNewestFirst (PURE — customer detail page match, #58) ─────

describe('mergeInvoicesNewestFirst', () => {
  const inv = (id: string, created_at: string, extra: Record<string, unknown> = {}): InvoiceRow =>
    ({ id, created_at, ...extra }) as unknown as InvoiceRow;

  it('de-duplicates rows that appear in more than one input list, newest-first', () => {
    const a = inv('i1', '2026-06-01');
    const b = inv('i2', '2026-06-05');
    const aAgain = inv('i1', '2026-06-01'); // e.g. matched by BOTH customer_id and quote_id
    const merged = mergeInvoicesNewestFirst([a, b], [aAgain, b]);
    expect(merged.map((i) => i.id)).toEqual(['i2', 'i1']);
    expect(merged).toHaveLength(2);
  });

  it('returns [] for no lists or all-empty lists', () => {
    expect(mergeInvoicesNewestFirst()).toEqual([]);
    expect(mergeInvoicesNewestFirst([], [])).toEqual([]);
  });

  it('a later list wins on a same-id collision (last-write-wins)', () => {
    const stale = inv('i1', '2026-06-01', { status: 'draft' });
    const fresh = inv('i1', '2026-06-01', { status: 'paid' });
    const merged = mergeInvoicesNewestFirst([stale], [fresh]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: 'i1', status: 'paid' });
  });
});

describe('listInvoicesForCustomer', () => {
  it('matches by customer_id OR quote_id, de-duplicated newest-first, excluding other customers', async () => {
    const { client } = makeFakeSupabase({
      invoices: [
        { id: 'inv1', customer_id: 'cust-1', quote_id: 'q1', created_at: '2026-06-01' },
        // legacy row: customer_id never backfilled, matched only via quote_id.
        { id: 'inv2', customer_id: null, quote_id: 'q2', created_at: '2026-06-05' },
        { id: 'inv3', customer_id: 'cust-2', quote_id: 'q3', created_at: '2026-06-10' },
      ],
    });
    sbRef.current = client;

    const invoices = await listInvoicesForCustomer('cust-1', ['q1', 'q2']);
    expect(invoices.map((i) => i.id)).toEqual(['inv2', 'inv1']); // newest first
  });

  it('returns [] when neither a customerId nor any quoteIds are given', async () => {
    const { client } = makeFakeSupabase({ invoices: [] });
    sbRef.current = client;
    expect(await listInvoicesForCustomer(null, [])).toEqual([]);
  });

  it('returns [] when Supabase is not configured', async () => {
    sbRef.current = null;
    expect(await listInvoicesForCustomer('cust-1', ['q1'])).toEqual([]);
  });
});
