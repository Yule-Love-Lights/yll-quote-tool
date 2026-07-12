import { describe, it, expect } from 'vitest';
import { buildQuoteDocModel, buildInvoiceDocModel, buildReceiptDocModel } from './docModels';
import type { PortalQuote } from '@/components/portal/types';
import type { InvoiceDetail, InvoiceRow } from '@/lib/invoices';

// Ledger #87(a) — the money gate. These builders must reproduce the EXACT
// figures already stored on PortalQuote / InvoiceDetail; nothing here should
// ever diverge from the source numbers.

// ─── buildQuoteDocModel ─────────────────────────────────────────────────────

const BASE_QUOTE: PortalQuote = {
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  customer: { firstName: 'Jasmine', fullName: 'Jasmine Smith', address: '45 Main Street, Huntington, NY 11743' },
  photo: { before: '', after: '', alt: '' },
  packages: [
    {
      id: 'A',
      name: 'Classic Glow',
      tagline: '',
      total: 1254.62,
      deposit: 627.31,
      includedItemIds: ['roofline-santas', 'spritzers'],
    },
    {
      id: 'C',
      name: 'Full House',
      tagline: '',
      total: 3389.06,
      deposit: 1694.53,
      recommended: true,
      includedItemIds: ['roofline-santas', 'tree-l', 'spritzers'],
    },
  ],
  lineItems: [
    { id: 'roofline-santas', kind: 'roofline', label: "Santa's Roofline", detail: '', price: 900 },
    { id: 'tree-l', kind: 'tree', label: 'Front-left tree', detail: '4 strands', price: 180 },
    { id: 'spritzers', kind: 'spritzer', label: '24" Spritzers', detail: '3 stakes', price: 255 },
  ],
  charges: { taxRate: 0.08625, rush: { amount: 0, defaultOn: false }, takedown: { amount: 0, defaultOn: false } },
  minimumOrderSubtotal: 1000,
};

describe('buildQuoteDocModel', () => {
  // #87a fix-batch HIGH finding #1: the quote PDF is approved-only — before
  // approval there's no persisted "current" selection to render, and the old
  // unapproved fallback (first .recommended package) rendered the WRONG
  // package/total on verticals (permanent/event) where no package is ever
  // .recommended. buildQuoteDocModel must never guess.
  it('throws when the quote has not been approved — must never render an unapproved guess', () => {
    expect(() => buildQuoteDocModel(BASE_QUOTE)).toThrow(/not approved/i);
  });

  it('approved quote: uses the FROZEN approval snapshot figures, not the live packages', () => {
    const approved: PortalQuote = {
      ...BASE_QUOTE,
      approval: {
        approvedAt: '2026-06-01T10:00:00Z',
        packageId: 'A',
        packageName: 'Classic Glow',
        totalUsd: 1254.62,
        depositUsd: 627.31,
        selectedItemCount: 2,
        selectedItemIds: ['roofline-santas', 'spritzers'],
        installTiming: 'none',
        rushSelected: false,
        takedownSelected: false,
      },
    };
    const model = buildQuoteDocModel(approved);
    expect(model.packageName).toBe('Classic Glow');
    expect(model.total).toBe('$1,254.62');
    expect(model.depositDue).toBe('$627.31');
    // Filtered to exactly the frozen selection, dropping the tree.
    expect(model.lineItems.map((li) => li.label)).toEqual(["Santa's Roofline", '24" Spritzers']);
    // Approved quotes date the document with the approval timestamp.
    expect(model.date).toBe('Jun 1, 2026');
    expect(model.quoteNumber).toBe('YLL-A1B2C3D4');
    expect(model.customerName).toBe('Jasmine Smith');
    expect(model.customerAddress).toBe(BASE_QUOTE.customer.address);
  });

  it('a divergent (Build Your Own / "D") approval restores the exact frozen item set even with no matching package', () => {
    const divergent: PortalQuote = {
      ...BASE_QUOTE,
      approval: {
        approvedAt: '2026-06-01T10:00:00Z',
        packageId: 'D',
        packageName: 'Build Your Own',
        totalUsd: 900,
        depositUsd: 450,
        selectedItemCount: 1,
        selectedItemIds: ['roofline-santas'],
        installTiming: 'none',
        rushSelected: false,
        takedownSelected: false,
      },
    };
    const model = buildQuoteDocModel(divergent);
    expect(model.packageName).toBe('Build Your Own');
    expect(model.total).toBe('$900');
    expect(model.lineItems.map((li) => li.label)).toEqual(["Santa's Roofline"]);
  });
});

// ─── buildInvoiceDocModel ───────────────────────────────────────────────────

function makeInvoiceRow(overrides: Partial<InvoiceRow> = {}): InvoiceRow {
  return {
    id: 'inv-1',
    invoice_number: 1042,
    job_id: 'job-1',
    quote_id: 'quote-1',
    customer_id: 'cust-1',
    subtotal: 5000,
    discount: 500,
    tax: 393.75,
    total: 4893.75,
    deposit_applied: 2446.88,
    balance: 2446.87,
    credit_note: 0,
    tax_overridden: false,
    status: 'awaiting_payment',
    valor_balance_txn_id: null,
    valor_receipt_url: null,
    created_at: '2026-06-10T00:00:00Z',
    paid_at: null,
    updated_at: '2026-06-10T00:00:00Z',
    ...overrides,
  };
}

function makeDetail(invoiceOverrides: Partial<InvoiceRow> = {}, detailOverrides: Partial<InvoiceDetail> = {}): InvoiceDetail {
  return {
    invoice: makeInvoiceRow(invoiceOverrides),
    customerName: 'Alice Anderson',
    customerEmail: 'alice@example.com',
    customerPhone: '555-0100',
    customerAddress: '1 Main St',
    isTest: false,
    jobNumber: 500,
    jobStatus: 'requires_invoicing',
    ...detailOverrides,
  };
}

// Parse a formatted money string ("$4,320.00" / "−$2,160.00") back to a signed number.
function parseMoney(s: string): number {
  const negative = s.startsWith('−') || s.startsWith('-');
  const n = Number(s.replace(/[−$,]/g, '').replace(/^-/, ''));
  return negative ? -n : n;
}

describe('buildInvoiceDocModel', () => {
  it('reproduces the exact stored headline totals, no recomputation', () => {
    const detail = makeDetail();
    const model = buildInvoiceDocModel(detail);
    expect(model.invoiceNumber).toBe('1042');
    expect(model.total).toBe('$4,893.75');
    expect(model.balanceDue).toBe('$2,446.87');
    expect(model.lines).toEqual([
      { label: 'Total', amount: '$4,893.75' },
      { label: 'Deposit applied', amount: '−$2,446.88' },
      { label: 'Balance due', amount: '$2,446.87' },
    ]);
    expect(model.creditNote).toBeNull();
    expect(model.status).toBe('awaiting_payment');
  });

  // #87a fix-batch MED finding #2 — the HARD REQUIREMENT: printed money lines
  // must reconcile. createInvoiceFromJob stores the FULL quote subtotal but
  // the AGREED (possibly partial) total/tax; permanent per-side packages make
  // a partial approval the DEFAULT, so this is not an edge case. Total −
  // Deposit applied === Balance due always (computeInvoiceTotals clamps
  // balance to max(0, total − deposit_applied) from already-cents-rounded
  // figures), and no Subtotal/Discount/Fees line is printed to contradict it.
  it('partial-approval invoice: money lines reconcile to the printed Total, with no Subtotal-exceeds-Total contradiction', () => {
    const detail = makeDetail({
      subtotal: 5000, // FULL quote subtotal — unscaled, would exceed the agreed total below
      discount: 0,
      tax: 320, // scaled to the agreed (partial) selection
      total: 4320, // the AGREED total, well below the full-quote subtotal
      deposit_applied: 2160,
      balance: 2160,
      credit_note: 0,
    });
    const model = buildInvoiceDocModel(detail);

    // No Subtotal/Discount/Fees/Tax line — those don't reconcile on a partial approval.
    expect(model.lines.map((l) => l.label)).toEqual(['Total', 'Deposit applied', 'Balance due']);

    const total = parseMoney(model.total);
    const depositLine = parseMoney(model.lines.find((l) => l.label === 'Deposit applied')!.amount);
    const balanceLine = parseMoney(model.lines.find((l) => l.label === 'Balance due')!.amount);
    // The reconciling identity: Total − Deposit applied === Balance due (exact).
    expect(Math.round((total + depositLine) * 100) / 100).toBe(balanceLine);
    // And the printed money lines (Total, −Deposit, +Balance) sum to the
    // printed Total for this fixture (deposit === balance, a 50/50 split).
    const sum = model.lines.reduce((acc, l) => acc + parseMoney(l.amount), 0);
    expect(sum).toBe(4320);
    expect(model.total).toBe('$4,320.00');
  });

  it('surfaces a credit note line + field when the deposit overpaid the (amended-down) total', () => {
    const detail = makeDetail({ total: 1000, deposit_applied: 1200, balance: 0, credit_note: 200 });
    const model = buildInvoiceDocModel(detail);
    expect(model.creditNote).toBe('$200.00');
    expect(model.lines).toContainEqual({ label: 'Credit (overpaid — manual refund)', amount: '$200.00' });
  });

  it('falls back to a short id when invoice_number is null', () => {
    const detail = makeDetail({ invoice_number: null, id: 'abcdef12-3456' });
    const model = buildInvoiceDocModel(detail);
    expect(model.invoiceNumber).toBe('ABCDEF12');
  });

  // #87a fix-batch MED finding #4: a cancelled invoice must carry its status
  // so the PDF can render a clear banner and never look like a valid/payable
  // document.
  it('threads status through so a cancelled invoice can never look valid', () => {
    const detail = makeDetail({ status: 'cancelled' });
    const model = buildInvoiceDocModel(detail);
    expect(model.status).toBe('cancelled');
  });
});

// ─── buildReceiptDocModel ───────────────────────────────────────────────────

describe('buildReceiptDocModel', () => {
  it('deposit-only (balance not yet collected): shows the deposit paid, no balance-paid line', () => {
    const detail = makeDetail({ status: 'awaiting_payment', deposit_applied: 2446.88, total: 4893.75, balance: 2446.87, paid_at: null });
    const model = buildReceiptDocModel(detail, { deposit_paid_at: '2026-06-10T08:00:00Z' });
    expect(model.depositPaid).toEqual({ amount: '$2,446.88', date: 'Jun 10, 2026' });
    expect(model.balancePaid).toBeNull();
    expect(model.totalPaid).toBe('$2,446.88');
  });

  it('paid in full: shows both the deposit and the reconstructed balance-paid amount/date', () => {
    const detail = makeDetail({
      status: 'paid',
      deposit_applied: 2446.88,
      total: 4893.75,
      balance: 0, // zeroed by settlement — the model must reconstruct the pre-settlement value
      paid_at: '2026-07-01T09:00:00Z',
    });
    const model = buildReceiptDocModel(detail, { deposit_paid_at: '2026-06-10T08:00:00Z' });
    expect(model.depositPaid).toEqual({ amount: '$2,446.88', date: 'Jun 10, 2026' });
    // 4893.75 - 2446.88 = 2446.87 (the exact balance the invoice held pre-payment)
    expect(model.balancePaid).toEqual({ amount: '$2,446.87', date: 'Jul 1, 2026' });
    expect(model.totalPaid).toBe('$4,893.75');
  });

  it('carries the valor receipt url through untouched when present', () => {
    const detail = makeDetail({ valor_receipt_url: 'https://valor.example/r/abc123' });
    const model = buildReceiptDocModel(detail, { deposit_paid_at: null });
    expect(model.valorReceiptUrl).toBe('https://valor.example/r/abc123');
  });

  it('no deposit_paid_at on the quote row: deposit line omitted even if deposit_applied > 0', () => {
    const detail = makeDetail({ deposit_applied: 500 });
    const model = buildReceiptDocModel(detail, { deposit_paid_at: null });
    expect(model.depositPaid).toBeNull();
  });

  // #87a fix-batch MED finding #3: totalPaid must be the SUM of the actual
  // collected pieces (deposit + balance), never `status==='paid' ? total : …`.
  // An amend-down that auto-promotes an invoice to 'paid' with deposit_applied
  // already ≥ the reduced total means the customer only ever paid the deposit
  // — totalPaid must equal deposit_applied, NOT the (smaller) total.
  it('amend-down-to-paid: deposit_applied exceeds the reduced total — totalPaid equals deposit_applied, not total', () => {
    const detail = makeDetail({
      status: 'paid',
      deposit_applied: 1200,
      total: 1000, // amended down after the deposit was collected
      balance: 0,
      credit_note: 200,
      paid_at: '2026-07-01T09:00:00Z',
    });
    const model = buildReceiptDocModel(detail, { deposit_paid_at: '2026-06-01T00:00:00Z' });
    expect(model.balancePaid).toBeNull(); // no balance was ever collected
    expect(model.totalPaid).toBe('$1,200.00'); // the deposit, not the (smaller) total
  });

  it('threads status through so a cancelled receipt can never look valid', () => {
    const detail = makeDetail({ status: 'cancelled' });
    const model = buildReceiptDocModel(detail, { deposit_paid_at: null });
    expect(model.status).toBe('cancelled');
  });
});
