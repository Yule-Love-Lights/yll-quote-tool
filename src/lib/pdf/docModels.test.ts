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
  it('unapproved quote: falls back to the recommended package, pulling its stored total/deposit verbatim', () => {
    const model = buildQuoteDocModel(BASE_QUOTE, new Date('2026-07-12T12:00:00Z'));
    expect(model.isApproved).toBe(false);
    expect(model.packageName).toBe('Full House');
    // Byte-match: no recomputation, straight from packages[1].total/.deposit.
    expect(model.total).toBe('$3,389.06');
    expect(model.depositDue).toBe('$1,694.53');
    expect(model.lineItems.map((li) => li.label)).toEqual(["Santa's Roofline", 'Front-left tree', '24" Spritzers']);
    expect(model.quoteNumber).toBe('YLL-A1B2C3D4');
    expect(model.customerName).toBe('Jasmine Smith');
    expect(model.customerAddress).toBe(BASE_QUOTE.customer.address);
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
    const model = buildQuoteDocModel(approved, new Date('2026-07-12T12:00:00Z'));
    expect(model.isApproved).toBe(true);
    expect(model.packageName).toBe('Classic Glow');
    expect(model.total).toBe('$1,254.62');
    expect(model.depositDue).toBe('$627.31');
    // Filtered to exactly the frozen selection, dropping the tree.
    expect(model.lineItems.map((li) => li.label)).toEqual(["Santa's Roofline", '24" Spritzers']);
    // Approved quotes date the document with the approval timestamp.
    expect(model.date).toBe('Jun 1, 2026');
  });

  it('unapproved quote with no recommended tier falls back to the first non-empty package', () => {
    const noRec: PortalQuote = {
      ...BASE_QUOTE,
      packages: BASE_QUOTE.packages.map((p) => ({ ...p, recommended: false })),
    };
    const model = buildQuoteDocModel(noRec, new Date('2026-07-12T12:00:00Z'));
    expect(model.packageName).toBe('Classic Glow');
    expect(model.total).toBe('$1,254.62');
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

describe('buildInvoiceDocModel', () => {
  it('reproduces the exact stored totals, no recomputation of the headline figures', () => {
    const detail = makeDetail();
    const model = buildInvoiceDocModel(detail);
    expect(model.invoiceNumber).toBe('1042');
    expect(model.total).toBe('$4,893.75');
    expect(model.balanceDue).toBe('$2,446.87');
    expect(model.lines).toEqual(
      expect.arrayContaining([
        { label: 'Subtotal', amount: '$5,000.00' },
        { label: 'Discount', amount: '−$500.00' },
        { label: 'Tax', amount: '$393.75' },
        { label: 'Total', amount: '$4,893.75' },
        { label: 'Deposit applied', amount: '−$2,446.88' },
        { label: 'Balance due', amount: '$2,446.87' },
      ]),
    );
    expect(model.creditNote).toBeNull();
  });

  it('shows the rush/takedown fees line using the same derivation as the admin invoice page', () => {
    // subtotal 5000, discount 0, tax 429, total 5679 (250 in fees embedded:
    // total = subtotal - discount + tax + fees)
    const detail = makeDetail({ subtotal: 5000, discount: 0, tax: 429, total: 5679, deposit_applied: 2839.5, balance: 2839.5 });
    const model = buildInvoiceDocModel(detail);
    expect(model.lines).toContainEqual({ label: 'Rush / takedown fees', amount: '$250.00' });
  });

  it('surfaces a credit note when the deposit overpaid the (amended-down) total', () => {
    const detail = makeDetail({ total: 1000, deposit_applied: 1200, balance: 0, credit_note: 200 });
    const model = buildInvoiceDocModel(detail);
    expect(model.creditNote).toBe('$200.00');
  });

  it('labels an overridden tax line', () => {
    const detail = makeDetail({ tax_overridden: true, tax: 0 });
    const model = buildInvoiceDocModel(detail);
    expect(model.lines).toContainEqual({ label: 'Tax (overridden)', amount: '$0.00' });
  });

  it('falls back to a short id when invoice_number is null', () => {
    const detail = makeDetail({ invoice_number: null, id: 'abcdef12-3456' });
    const model = buildInvoiceDocModel(detail);
    expect(model.invoiceNumber).toBe('ABCDEF12');
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
});
