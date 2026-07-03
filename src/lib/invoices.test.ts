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
  getInvoiceDetail,
  listInvoicesForAdmin,
  markInvoicePaidManually,
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
});

// ─── reads / unconfigured ───────────────────────────────────────────────────

describe('getInvoiceByJob', () => {
  it('returns null safely when Supabase is unconfigured', async () => {
    sbRef.current = null;
    expect(await getInvoiceByJob('j1')).toBeNull();
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
    // Agreed total 3000, minus the full tax line 393.75 → 2606.25. NOT 4500.
    expect(inv!.total).toBe(2606.25);
    expect(inv!.tax).toBe(0);
    expect(inv!.balance).toBe(1106.25); // 2606.25 − 1500
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

  it('returns null when the invoice does not exist', async () => {
    const fake = makeFakeSupabase({ invoices: [] });
    sbRef.current = fake.client;
    expect(await markInvoicePaidManually('nope')).toBeNull();
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
});
