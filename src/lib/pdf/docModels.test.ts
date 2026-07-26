import { describe, it, expect } from 'vitest';
import {
  buildQuoteDocModel,
  buildInvoiceDocModel,
  buildReceiptDocModel,
  resolveAgreedLineItems,
} from './docModels';
import type { PortalQuote } from '@/components/portal/types';
import type { InvoiceDetail, InvoiceRow } from '@/lib/invoices';

// Ledger #87(a) Jobber-format redesign — the money gate. These builders must
// reproduce the EXACT figures already stored on PortalQuote / InvoiceDetail,
// and any itemized breakdown they ADD must always reconcile to the printed
// Total (never print a Subtotal/Discount/Fees/Tax stack that doesn't sum).

// Parse a formatted money string ("$4,320.00" / "−$2,160.00") back to a signed number.
function parseMoney(s: string): number {
  const negative = s.startsWith('−') || s.startsWith('-');
  const n = Number(s.replace(/[−$,]/g, '').replace(/^-/, ''));
  return negative ? -n : n;
}

// ─── buildQuoteDocModel ─────────────────────────────────────────────────────

const BASE_QUOTE: PortalQuote = {
  id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  customer: {
    firstName: 'Jasmine',
    fullName: 'Jasmine Smith',
    address: '45 Main Street, Huntington, NY 11743',
    phone: '(631) 555-0100',
  },
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

  it('approved quote: uses the FROZEN approval snapshot figures, recipient/service fields, and an itemized breakdown that reconciles', () => {
    const approved: PortalQuote = {
      ...BASE_QUOTE,
      serviceType: 'holiday',
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
    expect(model.lineItems.every((li) => li.qty === 1)).toBe(true);
    expect(model.lineItems[0]!.unitPrice).toBe(model.lineItems[0]!.amount);
    // Approved quotes date the document with the approval timestamp.
    expect(model.date).toBe('Jun 1, 2026');
    expect(model.quoteNumber).toBe('YLL-A1B2C3D4');
    expect(model.recipient).toEqual({
      name: 'Jasmine Smith',
      billingAddress: BASE_QUOTE.customer.address,
      phone: '(631) 555-0100',
      serviceAddress: BASE_QUOTE.customer.address,
    });
    expect(model.serviceType).toBe('Holiday');
    expect(model.status).toBeNull();

    // Itemized breakdown reconciles: Subtotal + Tax === Total (no fees/discount
    // on this fixture — the agreed items' real sum already equals the taxable
    // amount derived from the frozen total).
    expect(model.subtotal).toBe('$1,155.00');
    expect(model.discount).toBeNull();
    expect(model.fees).toBeNull();
    expect(model.taxLabel).toBe('Sales Tax (8.625%)');
    expect(model.tax).toBe('$99.62');
    expect(parseMoney(model.subtotal!) + parseMoney(model.tax!)).toBeCloseTo(parseMoney(model.total), 2);
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

  it('a cancelled order never prints a clean-looking quote', () => {
    const cancelled: PortalQuote = {
      ...BASE_QUOTE,
      quoteStatus: 'cancelled',
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
    const model = buildQuoteDocModel(cancelled);
    expect(model.status).toBe('cancelled');
  });
});

// Booking bug batch 2026-07-17: the quote PDF must reflect a paid deposit —
// once deposit_paid_at is set, "Deposit due" becomes "Deposit paid (date)"
// plus a "Balance due" row (total minus deposit), while an unpaid quote
// renders exactly as before (regression guard).
describe('buildQuoteDocModel — paid deposit', () => {
  function approvedQuote(overrides: Partial<NonNullable<PortalQuote['approval']>> = {}): PortalQuote {
    return {
      ...BASE_QUOTE,
      serviceType: 'holiday',
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
        ...overrides,
      },
    };
  }

  it('unpaid quote: depositDue unchanged, no paid/balance fields (regression guard)', () => {
    const model = buildQuoteDocModel(approvedQuote());
    expect(model.depositDue).toBe('$627.31');
    expect(model.depositPaid).toBeNull();
    expect(model.balanceDue).toBeNull();
  });

  it('paid quote: shows the paid deposit (amount + formatted date) and a balance due that catches float drift', () => {
    const model = buildQuoteDocModel(
      approvedQuote({
        totalUsd: 978.76,
        depositUsd: 489.38,
        depositPaidAt: '2026-06-05T12:00:00Z',
      }),
    );
    expect(model.depositPaid).toEqual({ amount: '$489.38', date: 'Jun 5, 2026' });
    expect(model.balanceDue).toBe('$489.38');
  });

  it('deposit equal to total: balance due is $0.00, never negative', () => {
    const model = buildQuoteDocModel(
      approvedQuote({
        totalUsd: 900,
        depositUsd: 900,
        depositPaidAt: '2026-06-05T12:00:00Z',
      }),
    );
    expect(model.balanceDue).toBe('$0.00');
  });
});

// ─── resolveAgreedLineItems ─────────────────────────────────────────────────

describe('resolveAgreedLineItems', () => {
  it('returns null when the quote has no approval snapshot — nothing agreed to read', () => {
    expect(resolveAgreedLineItems(BASE_QUOTE)).toBeNull();
  });

  it('includes a real, selected rush/takedown fee amount (not fabricated) and labels it', () => {
    const withFees: PortalQuote = {
      ...BASE_QUOTE,
      charges: { taxRate: 0.08625, rush: { amount: 150, defaultOn: false }, takedown: { amount: 75, defaultOn: false } },
      approval: {
        approvedAt: '2026-06-01T10:00:00Z',
        packageId: 'A',
        packageName: 'Classic Glow',
        totalUsd: 1254.62,
        depositUsd: 627.31,
        selectedItemCount: 2,
        selectedItemIds: ['roofline-santas', 'spritzers'],
        installTiming: 'none',
        rushSelected: true,
        takedownSelected: true,
      },
    };
    const agreed = resolveAgreedLineItems(withFees)!;
    expect(agreed.fees).toBe(225);
    expect(agreed.feesLabel).toBe('Rush install fee + Premium takedown fee');
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
    valor_txn_log: null,
    payment_preference: null,
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
  it('reproduces the exact stored headline totals with no source quote (no itemized breakdown, minimal set still reconciles)', () => {
    const detail = makeDetail();
    const model = buildInvoiceDocModel(detail, null);
    expect(model.invoiceNumber).toBe('1042');
    expect(model.total).toBe('$4,893.75');
    expect(model.invoiceBalance).toBe('$2,446.87');
    expect(model.accountBalance).toBe('$2,446.87');
    expect(model.depositCollected).toBe('$2,446.88');
    expect(model.paidTowardBalance).toBe('$0.00'); // not yet paid
    expect(model.creditNote).toBeNull();
    expect(model.status).toBe('awaiting_payment');
    // No source quote ⇒ the itemized breakdown is unavailable, not guessed.
    expect(model.subtotal).toBeNull();
    expect(model.discount).toBeNull();
    expect(model.fees).toBeNull();
    expect(model.taxLabel).toBeNull();
    expect(model.tax).toBeNull();
    // The minimal always-reconciling identity: Total − Deposit − Paid + Credit === Balance.
    const total = parseMoney(model.total);
    const deposit = parseMoney(model.depositCollected);
    const paid = parseMoney(model.paidTowardBalance);
    expect(Math.round((total - deposit - paid) * 100) / 100).toBe(parseMoney(model.invoiceBalance));
  });

  // #87a fix-batch MED finding #2 — the HARD REQUIREMENT: printed money lines
  // must reconcile even on a partial approval (the DEFAULT for permanent
  // per-side packages): the FULL quote subtotal (5000) is well above the
  // AGREED total (4320), but the itemized Subtotal is sourced from the AGREED
  // line items (resolveAgreedLineItems), not the stored (unscaled) invoice
  // subtotal column — so it reconciles exactly instead of exceeding Total.
  it('partial-approval invoice: the itemized Subtotal is sourced from the AGREED items and reconciles to the printed Total, with no Subtotal-exceeds-Total contradiction', () => {
    const detail = makeDetail({
      subtotal: 5000, // FULL quote subtotal — unscaled, would exceed the agreed total below
      discount: 0,
      tax: 320, // scaled to the agreed (partial) selection
      total: 4320, // the AGREED total, well below the full-quote subtotal
      deposit_applied: 2160,
      balance: 2160,
      credit_note: 0,
    });
    const portalQuote: PortalQuote = {
      ...BASE_QUOTE,
      lineItems: [
        { id: 'item-a', kind: 'roofline', label: 'Item A', detail: '', price: 2000 },
        { id: 'item-b', kind: 'tree', label: 'Item B', detail: '', price: 2000 },
        { id: 'item-c', kind: 'spritzer', label: 'Item C (not agreed)', detail: '', price: 1000 }, // the other $1,000 of the full $5,000 quote
      ],
      packages: [{ id: 'D', name: 'Build Your Own', tagline: '', total: 4320, deposit: 2160, includedItemIds: [] }],
      charges: { taxRate: 0.08, rush: { amount: 0, defaultOn: false }, takedown: { amount: 0, defaultOn: false } },
      approval: {
        approvedAt: '2026-06-10T00:00:00Z',
        packageId: 'D',
        packageName: 'Build Your Own',
        totalUsd: 4320,
        depositUsd: 2160,
        selectedItemCount: 2,
        selectedItemIds: ['item-a', 'item-b'], // AGREED — item-c was deselected
        installTiming: 'none',
        rushSelected: false,
        takedownSelected: false,
      },
    };

    const model = buildInvoiceDocModel(detail, portalQuote);

    // The itemized Subtotal is the AGREED $4,000 (item-a + item-b), never the
    // stored $5,000 full-quote column.
    expect(model.subtotal).toBe('$4,000.00');
    // item-b is kind 'tree' → a single wrapped item renders as "Tree" (customer
    // PDFs hide the per-strand label). The AGREED subtotal is unchanged.
    expect(model.lineItems.map((li) => li.label)).toEqual(['Item A', 'Tree']);
    expect(model.discount).toBeNull(); // nothing unexplained — no fabricated discount
    expect(model.fees).toBeNull();
    expect(model.tax).toBe('$320.00');

    const subtotal = parseMoney(model.subtotal!);
    const tax = parseMoney(model.tax!);
    const total = parseMoney(model.total);
    // The reconciling identity this whole redesign hinges on.
    expect(subtotal + tax).toBe(total);
    expect(model.total).toBe('$4,320.00');

    // The Deposit/Paid/Balance chain (independent of the itemized block) also reconciles.
    expect(model.depositCollected).toBe('$2,160.00');
    expect(model.invoiceBalance).toBe('$2,160.00');
    expect(model.accountBalance).toBe('$2,160.00');
  });

  // Regression (post-merge audit): the agreed line-item Subtotal is EXACT but
  // the invoice's scaled `tax` column is independently rounded, so on some
  // partial approvals the derived discount lands a cent negative, was clamped
  // to 0, and left the printed Subtotal + Tax a cent SHORT of Total (or printed
  // a spurious ~1c Discount). The tax line now absorbs the ≤2c residual so the
  // stack sums to Total exactly in this rounding band too.
  it('rounding-band partial approval: Subtotal + Tax === Total to the cent, no 1c short and no spurious discount', () => {
    const detail = makeDetail({
      subtotal: 600, // full-quote column (unused for the itemized subtotal)
      discount: 0,
      tax: 31.37, // scaled + independently rounded → creates the ±1c band
      total: 533.38,
      deposit_applied: 266.69,
      balance: 266.69,
      credit_note: 0,
    });
    const portalQuote: PortalQuote = {
      ...BASE_QUOTE,
      lineItems: [
        { id: 'item-a', kind: 'roofline', label: 'Item A', detail: '', price: 251 },
        { id: 'item-b', kind: 'tree', label: 'Item B', detail: '', price: 251 },
      ],
      packages: [{ id: 'D', name: 'Build Your Own', tagline: '', total: 533.38, deposit: 266.69, includedItemIds: [] }],
      charges: { taxRate: 0.0625, rush: { amount: 0, defaultOn: false }, takedown: { amount: 0, defaultOn: false } },
      approval: {
        approvedAt: '2026-06-10T00:00:00Z',
        packageId: 'D',
        packageName: 'Build Your Own',
        totalUsd: 533.38,
        depositUsd: 266.69,
        selectedItemCount: 2,
        selectedItemIds: ['item-a', 'item-b'],
        installTiming: 'none',
        rushSelected: false,
        takedownSelected: false,
      },
    };

    const model = buildInvoiceDocModel(detail, portalQuote);

    expect(model.subtotal).toBe('$502.00');
    expect(model.discount).toBeNull(); // the -1c artifact is NOT shown as a discount
    expect(model.fees).toBeNull();
    // The stack reconciles EXACTLY — the ≤2c residual was absorbed into tax
    // (shown $31.38, one cent above the stored $31.37) rather than left short.
    const subtotal = parseMoney(model.subtotal!);
    const tax = parseMoney(model.tax!);
    expect(subtotal + tax).toBe(parseMoney(model.total));
    expect(model.total).toBe('$533.38');
  });

  it('rounding-band with a small POSITIVE residual: no spurious ~1c Discount line, stack still reconciles', () => {
    const detail = makeDetail({
      subtotal: 600,
      discount: 0,
      tax: 31.37,
      total: 533.38,
      deposit_applied: 266.69,
      balance: 266.69,
      credit_note: 0,
    });
    const portalQuote: PortalQuote = {
      ...BASE_QUOTE,
      lineItems: [
        { id: 'item-a', kind: 'roofline', label: 'Item A', detail: '', price: 251.01 },
        { id: 'item-b', kind: 'tree', label: 'Item B', detail: '', price: 251.01 },
      ],
      packages: [{ id: 'D', name: 'Build Your Own', tagline: '', total: 533.38, deposit: 266.69, includedItemIds: [] }],
      charges: { taxRate: 0.0625, rush: { amount: 0, defaultOn: false }, takedown: { amount: 0, defaultOn: false } },
      approval: {
        approvedAt: '2026-06-10T00:00:00Z',
        packageId: 'D',
        packageName: 'Build Your Own',
        totalUsd: 533.38,
        depositUsd: 266.69,
        selectedItemCount: 2,
        selectedItemIds: ['item-a', 'item-b'],
        installTiming: 'none',
        rushSelected: false,
        takedownSelected: false,
      },
    };

    const model = buildInvoiceDocModel(detail, portalQuote);

    expect(model.subtotal).toBe('$502.02');
    expect(model.discount).toBeNull(); // +1c rounding noise is absorbed, not printed as a discount
    expect(parseMoney(model.subtotal!) + parseMoney(model.tax!)).toBe(parseMoney(model.total));
  });

  it('a REAL discount (above the rounding band) is still shown, and the stack reconciles', () => {
    const detail = makeDetail({
      subtotal: 600,
      discount: 0,
      tax: 31.37,
      total: 533.38,
      deposit_applied: 266.69,
      balance: 266.69,
      credit_note: 0,
    });
    const portalQuote: PortalQuote = {
      ...BASE_QUOTE,
      lineItems: [
        { id: 'item-a', kind: 'roofline', label: 'Item A', detail: '', price: 300 },
        { id: 'item-b', kind: 'tree', label: 'Item B', detail: '', price: 300 },
      ],
      packages: [{ id: 'D', name: 'Build Your Own', tagline: '', total: 533.38, deposit: 266.69, includedItemIds: [] }],
      charges: { taxRate: 0.0625, rush: { amount: 0, defaultOn: false }, takedown: { amount: 0, defaultOn: false } },
      approval: {
        approvedAt: '2026-06-10T00:00:00Z',
        packageId: 'D',
        packageName: 'Build Your Own',
        totalUsd: 533.38,
        depositUsd: 266.69,
        selectedItemCount: 2,
        selectedItemIds: ['item-a', 'item-b'],
        installTiming: 'none',
        rushSelected: false,
        takedownSelected: false,
      },
    };

    const model = buildInvoiceDocModel(detail, portalQuote);

    expect(model.subtotal).toBe('$600.00');
    expect(model.discount).not.toBeNull(); // a genuine ~$98 discount IS shown
    expect(model.tax).toBe('$31.37'); // with a real discount the tax equals the stored figure
    const subtotal = parseMoney(model.subtotal!);
    const discount = parseMoney(model.discount!.amount); // "-$97.99" → -97.99
    const tax = parseMoney(model.tax!);
    expect(subtotal + discount + tax).toBe(parseMoney(model.total));
  });

  it('an invoice with a selected rush fee: the Fees line is real (not derived) and the stack still reconciles', () => {
    const detail = makeDetail({
      subtotal: 1000,
      discount: 0,
      tax: 88,
      total: 1188,
      deposit_applied: 594,
      balance: 594,
      credit_note: 0,
    });
    const portalQuote: PortalQuote = {
      ...BASE_QUOTE,
      lineItems: [{ id: 'item-a', kind: 'roofline', label: 'Item A', detail: '', price: 1000 }],
      packages: [{ id: 'D', name: 'Build Your Own', tagline: '', total: 1188, deposit: 594, includedItemIds: [] }],
      charges: { taxRate: 0.08, rush: { amount: 100, defaultOn: false }, takedown: { amount: 0, defaultOn: false } },
      approval: {
        approvedAt: '2026-06-10T00:00:00Z',
        packageId: 'D',
        packageName: 'Build Your Own',
        totalUsd: 1188,
        depositUsd: 594,
        selectedItemCount: 1,
        selectedItemIds: ['item-a'],
        installTiming: 'none',
        rushSelected: true,
        takedownSelected: false,
      },
    };

    const model = buildInvoiceDocModel(detail, portalQuote);
    expect(model.subtotal).toBe('$1,000.00');
    expect(model.fees).toEqual({ label: 'Rush install fee', amount: '$100.00' });
    expect(model.discount).toBeNull();
    expect(model.tax).toBe('$88.00');

    const subtotal = parseMoney(model.subtotal!);
    const fees = parseMoney(model.fees!.amount);
    const tax = parseMoney(model.tax!);
    expect(subtotal + fees + tax).toBe(parseMoney(model.total));
  });

  // Correctness beats completeness (#87a scope): when the agreed items can't
  // explain the printed Total (e.g. a post-approval amendment moved the price
  // in a way this quote snapshot doesn't reflect), the itemized block must be
  // omitted rather than print a fabricated/negative discount that papers over
  // the gap.
  it("falls back to the minimal reconciling set when the agreed items can't explain the Total", () => {
    const detail = makeDetail({
      subtotal: 5000,
      discount: 0,
      tax: 320,
      total: 4320, // e.g. amended UP after approval — no longer explained by the frozen selection
      deposit_applied: 2160,
      balance: 2160,
      credit_note: 0,
    });
    const portalQuote: PortalQuote = {
      ...BASE_QUOTE,
      lineItems: [{ id: 'item-a', kind: 'roofline', label: 'Item A', detail: '', price: 1000 }], // agreed items sum well short of the $4,000 taxable
      packages: [{ id: 'D', name: 'Build Your Own', tagline: '', total: 1080, deposit: 540, includedItemIds: [] }],
      charges: { taxRate: 0.08, rush: { amount: 0, defaultOn: false }, takedown: { amount: 0, defaultOn: false } },
      approval: {
        approvedAt: '2026-06-10T00:00:00Z',
        packageId: 'D',
        packageName: 'Build Your Own',
        totalUsd: 1080,
        depositUsd: 540,
        selectedItemCount: 1,
        selectedItemIds: ['item-a'],
        installTiming: 'none',
        rushSelected: false,
        takedownSelected: false,
      },
    };

    const model = buildInvoiceDocModel(detail, portalQuote);
    expect(model.subtotal).toBeNull();
    expect(model.discount).toBeNull();
    expect(model.fees).toBeNull();
    expect(model.taxLabel).toBeNull();
    expect(model.tax).toBeNull();
    // The minimal set is still present and still reconciles.
    expect(model.total).toBe('$4,320.00');
    expect(model.depositCollected).toBe('$2,160.00');
    expect(model.invoiceBalance).toBe('$2,160.00');
  });

  it('surfaces a credit note line + field when the deposit overpaid the (amended-down) total, and the full chain still reconciles', () => {
    const detail = makeDetail({ total: 1000, deposit_applied: 1200, balance: 0, credit_note: 200, status: 'paid', paid_at: '2026-07-01T09:00:00Z' });
    const model = buildInvoiceDocModel(detail, null);
    expect(model.creditNote).toBe('$200.00');
    expect(model.paidTowardBalance).toBe('$0.00'); // deposit alone already covered the (reduced) total
    const total = parseMoney(model.total);
    const deposit = parseMoney(model.depositCollected);
    const paid = parseMoney(model.paidTowardBalance);
    const credit = parseMoney(model.creditNote!);
    expect(Math.round((total - deposit - paid + credit) * 100) / 100).toBe(parseMoney(model.invoiceBalance));
  });

  it('falls back to a short id when invoice_number is null', () => {
    const detail = makeDetail({ invoice_number: null, id: 'abcdef12-3456' });
    const model = buildInvoiceDocModel(detail, null);
    expect(model.invoiceNumber).toBe('ABCDEF12');
  });

  // #87a fix-batch MED finding #4: a cancelled invoice must carry its status
  // so the PDF can render a clear watermark and never look like a valid/payable
  // document.
  it('threads status through so a cancelled invoice can never look valid', () => {
    const detail = makeDetail({ status: 'cancelled' });
    const model = buildInvoiceDocModel(detail, null);
    expect(model.status).toBe('cancelled');
  });

  it('a fully paid invoice: Paid reconstructs the pre-settlement balance and the chain reconciles to a zero balance', () => {
    const detail = makeDetail({
      total: 4893.75,
      deposit_applied: 2446.88,
      balance: 0, // zeroed by settlement
      status: 'paid',
      paid_at: '2026-07-01T09:00:00Z',
    });
    const model = buildInvoiceDocModel(detail, null);
    expect(model.paidTowardBalance).toBe('$2,446.87');
    expect(model.invoiceBalance).toBe('$0.00');
    const total = parseMoney(model.total);
    const deposit = parseMoney(model.depositCollected);
    const paid = parseMoney(model.paidTowardBalance);
    expect(Math.round((total - deposit - paid) * 100) / 100).toBe(0);
  });
});

// ─── buildReceiptDocModel ───────────────────────────────────────────────────

describe('buildReceiptDocModel', () => {
  it('deposit-only (balance not yet collected): shows the deposit paid, no balance-paid line', () => {
    const detail = makeDetail({ status: 'awaiting_payment', deposit_applied: 2446.88, total: 4893.75, balance: 2446.87, paid_at: null });
    const model = buildReceiptDocModel(detail, { deposit_paid_at: '2026-06-10T08:00:00Z' }, null);
    expect(model.depositPaid).toEqual({ amount: '$2,446.88', date: 'Jun 10, 2026' });
    expect(model.balancePaid).toBeNull();
    expect(model.totalPaid).toBe('$2,446.88');
    expect(model.paidDate).toBe('Jun 10, 2026');
  });

  it('paid in full: shows both the deposit and the reconstructed balance-paid amount/date', () => {
    const detail = makeDetail({
      status: 'paid',
      deposit_applied: 2446.88,
      total: 4893.75,
      balance: 0, // zeroed by settlement — the model must reconstruct the pre-settlement value
      paid_at: '2026-07-01T09:00:00Z',
    });
    const model = buildReceiptDocModel(detail, { deposit_paid_at: '2026-06-10T08:00:00Z' }, null);
    expect(model.depositPaid).toEqual({ amount: '$2,446.88', date: 'Jun 10, 2026' });
    // 4893.75 - 2446.88 = 2446.87 (the exact balance the invoice held pre-payment)
    expect(model.balancePaid).toEqual({ amount: '$2,446.87', date: 'Jul 1, 2026' });
    expect(model.totalPaid).toBe('$4,893.75');
    expect(model.paidDate).toBe('Jul 1, 2026');
  });

  it('carries the valor receipt url through untouched when present', () => {
    const detail = makeDetail({ valor_receipt_url: 'https://valor.example/r/abc123' });
    const model = buildReceiptDocModel(detail, { deposit_paid_at: null }, null);
    expect(model.valorReceiptUrl).toBe('https://valor.example/r/abc123');
  });

  it('no deposit_paid_at on the quote row: deposit line omitted even if deposit_applied > 0', () => {
    const detail = makeDetail({ deposit_applied: 500 });
    const model = buildReceiptDocModel(detail, { deposit_paid_at: null }, null);
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
    const model = buildReceiptDocModel(detail, { deposit_paid_at: '2026-06-01T00:00:00Z' }, null);
    expect(model.balancePaid).toBeNull(); // no balance was ever collected
    expect(model.totalPaid).toBe('$1,200.00'); // the deposit, not the (smaller) total
  });

  it('threads status through so a cancelled receipt can never look valid', () => {
    const detail = makeDetail({ status: 'cancelled' });
    const model = buildReceiptDocModel(detail, { deposit_paid_at: null }, null);
    expect(model.status).toBe('cancelled');
  });

  it('with a source quote: carries recipient/service-type/line-items through for the Jobber-format layout', () => {
    const detail = makeDetail();
    const withApproval: PortalQuote = {
      ...BASE_QUOTE,
      serviceType: 'permanent',
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
    const model = buildReceiptDocModel(detail, { deposit_paid_at: null }, withApproval);
    expect(model.serviceType).toBe('Permanent');
    expect(model.lineItems.map((li) => li.label)).toEqual(["Santa's Roofline", '24" Spritzers']);
    expect(model.recipient.phone).toBe('555-0100'); // from InvoiceDetail.customerPhone, not the portal quote
  });
});

describe('resolveAgreedLineItems — wrapped-item grouping (bush/tree/column) on customer PDFs', () => {
  const quoteWith = (lineItems: PortalQuote['lineItems']): PortalQuote => ({
    ...BASE_QUOTE,
    lineItems,
    packages: [{ id: 'D', name: 'Build Your Own', tagline: '', total: 0, deposit: 0, includedItemIds: [] }],
    charges: { taxRate: 0, rush: { amount: 0, defaultOn: false }, takedown: { amount: 0, defaultOn: false } },
    approval: {
      approvedAt: '2026-06-10T00:00:00Z',
      packageId: 'D',
      packageName: 'Build Your Own',
      totalUsd: 0,
      depositUsd: 0,
      selectedItemCount: lineItems.length,
      selectedItemIds: lineItems.map((li) => li.id),
      installTiming: 'none',
      rushSelected: false,
      takedownSelected: false,
    },
  });

  it('collapses several bushes at MIXED prices into ONE "Bushes" row (Qty = count, blank Unit Price, summed Total) and never moves the subtotal', () => {
    const agreed = resolveAgreedLineItems(
      quoteWith([
        { id: 'roof', kind: 'roofline', label: "Santa's Roofline", detail: '', price: 320 },
        { id: 'b1', kind: 'bush', label: 'Bush – canopy wrap, 2 strings', detail: '2 strings', price: 70 },
        { id: 'b2', kind: 'bush', label: 'Bush – canopy wrap, 2 strings', detail: '2 strings', price: 70 },
        { id: 'b3', kind: 'bush', label: 'Bush – canopy wrap, 3 strings', detail: '3 strings', price: 105 },
        { id: 'b4', kind: 'bush', label: 'Bush – canopy wrap, 2 strings', detail: '2 strings', price: 70 },
      ]),
    )!;
    // Roofline keeps its own row; the 4 bushes become ONE combined row in place.
    expect(agreed.items.map((i) => i.label)).toEqual(["Santa's Roofline", 'Bushes']);
    const bushes = agreed.items.find((i) => i.label === 'Bushes')!;
    expect(bushes.qty).toBe(4);
    expect(bushes.unitPrice).toBe(''); // mixed prices → blank; no strand counts leak
    expect(bushes.detail).toBe('');
    expect(bushes.amount).toBe('$315.00'); // 70+70+105+70
    // Money-safety: subtotal is summed from the ORIGINAL items, and the combined
    // rows' displayed amounts still sum to that exact subtotal.
    expect(agreed.subtotal).toBe(320 + 70 + 70 + 105 + 70);
    expect(agreed.items.reduce((s, i) => s + parseMoney(i.amount), 0)).toBe(agreed.subtotal);
  });

  it('shows the Unit Price when every wrapped item of a kind is the same price', () => {
    const row = resolveAgreedLineItems(
      quoteWith([
        { id: 'b1', kind: 'bush', label: 'Bush – canopy wrap, 2 strings', detail: '2 strings', price: 70 },
        { id: 'b2', kind: 'bush', label: 'Bush – canopy wrap, 2 strings', detail: '2 strings', price: 70 },
        { id: 'b3', kind: 'bush', label: 'Bush – canopy wrap, 2 strings', detail: '2 strings', price: 70 },
      ]),
    )!.items[0]!;
    expect(row.label).toBe('Bushes');
    expect(row.qty).toBe(3);
    expect(row.unitPrice).toBe('$70.00'); // uniform → unit price shown
    expect(row.amount).toBe('$210.00');
  });

  it('uses the singular label for a single wrapped item', () => {
    const row = resolveAgreedLineItems(
      quoteWith([{ id: 't1', kind: 'tree', label: 'Tree – trunk wrap, 5 strings', detail: '5 strings', price: 180 }]),
    )!.items[0]!;
    expect(row.label).toBe('Tree');
    expect(row.qty).toBe(1);
    expect(row.unitPrice).toBe('$180.00');
    expect(row.amount).toBe('$180.00');
  });

  it('groups each wrapped kind separately and leaves non-wrapped items untouched', () => {
    const items = resolveAgreedLineItems(
      quoteWith([
        { id: 'b1', kind: 'bush', label: 'Bush A', detail: '2 strings', price: 70 },
        { id: 't1', kind: 'tree', label: 'Tree A', detail: '4 strings', price: 180 },
        { id: 'c1', kind: 'column', label: 'Column A', detail: '3 strings', price: 90 },
        { id: 'c2', kind: 'column', label: 'Column B', detail: '3 strings', price: 90 },
        { id: 'w1', kind: 'wreath', label: '30" Noble Wreath', detail: 'Non-Decorated', price: 285 },
      ]),
    )!.items;
    expect(items.map((i) => `${i.label} x${i.qty}`)).toEqual(['Bush x1', 'Tree x1', 'Columns x2', '30" Noble Wreath x1']);
    // A non-wrapped item (wreath) keeps its own label + detail verbatim.
    expect(items.find((i) => i.label === '30" Noble Wreath')!.detail).toBe('Non-Decorated');
  });
});
