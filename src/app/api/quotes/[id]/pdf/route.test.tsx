// Tests for GET /api/quotes/[id]/pdf?doc=quote|invoice|receipt (ledger #87a).
//
// Auth model mirrors /api/quotes/[id] and the portal: the quote UUID is the
// capability token — no operator gate to mock. loadPortalQuote / getInvoiceByQuote
// / getInvoiceDetail / getQuoteRaw are mocked (their own money-safety is covered by
// docModels.test.ts and invoices.test.ts); renderToBuffer is stubbed so these tests
// stay fast and only assert routing/gating, not real PDF bytes.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const {
  loadPortalQuoteMock,
  getInvoiceByQuoteMock,
  getInvoiceDetailMock,
  getQuoteRawMock,
  renderToBufferMock,
} = vi.hoisted(() => ({
  loadPortalQuoteMock: vi.fn(),
  getInvoiceByQuoteMock: vi.fn(),
  getInvoiceDetailMock: vi.fn(),
  getQuoteRawMock: vi.fn(),
  renderToBufferMock: vi.fn(async () => Buffer.from('%PDF-FAKE')),
}));

vi.mock('@/lib/portal/loader', () => ({
  loadPortalQuote: loadPortalQuoteMock,
  isValidQuoteId: (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
  PortalConfigError: class PortalConfigError extends Error {},
}));
vi.mock('@/lib/invoices', () => ({
  getInvoiceByQuote: getInvoiceByQuoteMock,
  getInvoiceDetail: getInvoiceDetailMock,
}));
vi.mock('@/lib/quotes', () => ({ getQuoteRaw: getQuoteRawMock }));
vi.mock('@react-pdf/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@react-pdf/renderer')>();
  return { ...actual, renderToBuffer: renderToBufferMock };
});

import { GET } from './route';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function makeReq(id: string, doc: string | null): NextRequest {
  const url = new URL(`https://example.com/api/quotes/${id}/pdf`);
  if (doc !== null) url.searchParams.set('doc', doc);
  return { nextUrl: url } as unknown as NextRequest;
}
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

const BASE_PORTAL_QUOTE = {
  id: ID,
  customer: { firstName: 'Jasmine', fullName: 'Jasmine Smith', address: '45 Main St' },
  photo: { before: '', after: '', alt: '' },
  packages: [
    { id: 'C', name: 'Full House', tagline: '', total: 2000, deposit: 1000, recommended: true, includedItemIds: ['tree-l'] },
  ],
  lineItems: [{ id: 'tree-l', kind: 'tree', label: 'Front-left tree', detail: '', price: 2000 }],
  charges: { taxRate: 0.08625, rush: { amount: 0, defaultOn: false }, takedown: { amount: 0, defaultOn: false } },
  minimumOrderSubtotal: 1000,
};

// Fix-batch #87a HIGH #1 — the quote PDF is approved-only.
const APPROVED_PORTAL_QUOTE = {
  ...BASE_PORTAL_QUOTE,
  approval: {
    approvedAt: '2026-06-01T10:00:00Z',
    packageId: 'C',
    packageName: 'Full House',
    totalUsd: 2000,
    depositUsd: 1000,
    selectedItemCount: 1,
    selectedItemIds: ['tree-l'],
    installTiming: 'none',
    rushSelected: false,
    takedownSelected: false,
  },
};

const BASE_INVOICE_ROW = {
  id: 'inv-1',
  invoice_number: 1042,
  job_id: 'job-1',
  quote_id: ID,
  customer_id: 'cust-1',
  subtotal: 2000,
  discount: 0,
  tax: 172.5,
  total: 2172.5,
  deposit_applied: 1086.25,
  balance: 1086.25,
  credit_note: 0,
  tax_overridden: false,
  status: 'awaiting_payment',
  valor_balance_txn_id: null,
  valor_receipt_url: null,
  created_at: '2026-06-10T00:00:00Z',
  paid_at: null,
  updated_at: '2026-06-10T00:00:00Z',
};

const BASE_INVOICE_DETAIL = {
  invoice: BASE_INVOICE_ROW,
  customerName: 'Jasmine Smith',
  customerEmail: 'jasmine@example.com',
  customerPhone: '555-0100',
  customerAddress: '45 Main St',
  isTest: false,
  jobNumber: 500,
  jobStatus: 'requires_invoicing',
};

beforeEach(() => {
  vi.clearAllMocks();
  loadPortalQuoteMock.mockResolvedValue(APPROVED_PORTAL_QUOTE);
  getInvoiceByQuoteMock.mockResolvedValue(BASE_INVOICE_ROW);
  getInvoiceDetailMock.mockResolvedValue(BASE_INVOICE_DETAIL);
  getQuoteRawMock.mockResolvedValue({ deposit_paid_at: '2026-06-10T08:00:00Z' });
});

describe('GET /api/quotes/[id]/pdf', () => {
  it('400s on a malformed quote id', async () => {
    const res = await GET(makeReq('not-a-uuid', 'quote'), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it("400s when doc isn't one of quote/invoice/receipt", async () => {
    const res = await GET(makeReq(ID, 'bogus'), ctx());
    expect(res.status).toBe(400);
  });

  it('400s when doc is missing entirely', async () => {
    const res = await GET(makeReq(ID, null), ctx());
    expect(res.status).toBe(400);
  });

  describe('doc=quote', () => {
    it('404s cleanly when the quote does not load', async () => {
      loadPortalQuoteMock.mockResolvedValueOnce(null);
      const res = await GET(makeReq(ID, 'quote'), ctx());
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/not found/i);
    });

    // Fix-batch #87a HIGH #1 — approved-only. An unapproved quote has no
    // persisted "current" selection; the old fallback rendered the WRONG
    // package/total on verticals with no .recommended package.
    it('404s cleanly when the quote has not been approved yet', async () => {
      loadPortalQuoteMock.mockResolvedValueOnce(BASE_PORTAL_QUOTE); // no .approval
      const res = await GET(makeReq(ID, 'quote'), ctx());
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/available after approval/i);
      expect(renderToBufferMock).not.toHaveBeenCalled();
    });

    it('renders a PDF and never touches the invoice tables (approved quote)', async () => {
      const res = await GET(makeReq(ID, 'quote'), ctx());
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/pdf');
      expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="YuleLoveLights-Quote-.*\.pdf"$/);
      expect(getInvoiceByQuoteMock).not.toHaveBeenCalled();
      expect(renderToBufferMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('doc=invoice', () => {
    it('404s when there is no invoice for this quote yet', async () => {
      getInvoiceByQuoteMock.mockResolvedValueOnce(null);
      const res = await GET(makeReq(ID, 'invoice'), ctx());
      expect(res.status).toBe(404);
      expect(getInvoiceDetailMock).not.toHaveBeenCalled();
    });

    it('renders the invoice PDF with the invoice-number filename', async () => {
      const res = await GET(makeReq(ID, 'invoice'), ctx());
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Disposition')).toBe(
        'attachment; filename="YuleLoveLights-Invoice-1042.pdf"',
      );
    });
  });

  describe('doc=receipt', () => {
    it('404s when no payment has posted (no deposit, no paid_at)', async () => {
      getInvoiceByQuoteMock.mockResolvedValueOnce({ ...BASE_INVOICE_ROW, deposit_applied: 0, paid_at: null });
      const res = await GET(makeReq(ID, 'receipt'), ctx());
      expect(res.status).toBe(404);
      expect(getInvoiceDetailMock).not.toHaveBeenCalled();
    });

    it('renders when the deposit has been applied', async () => {
      const res = await GET(makeReq(ID, 'receipt'), ctx());
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Disposition')).toBe(
        'attachment; filename="YuleLoveLights-Receipt-1042.pdf"',
      );
      expect(getQuoteRawMock).toHaveBeenCalledWith(ID);
    });

    it('renders when the balance was later paid in full even with no deposit', async () => {
      getInvoiceByQuoteMock.mockResolvedValueOnce({
        ...BASE_INVOICE_ROW,
        deposit_applied: 0,
        status: 'paid',
        paid_at: '2026-07-01T00:00:00Z',
      });
      const res = await GET(makeReq(ID, 'receipt'), ctx());
      expect(res.status).toBe(200);
    });
  });

  it('surfaces a 503 when Supabase is unconfigured (PortalConfigError)', async () => {
    const { PortalConfigError } = await import('@/lib/portal/loader');
    loadPortalQuoteMock.mockRejectedValueOnce(new PortalConfigError('Supabase service role not configured'));
    const res = await GET(makeReq(ID, 'quote'), ctx());
    expect(res.status).toBe(503);
  });

  // Fix-batch #87a LOW #5 — the route's catch-all was never exercised (every
  // other test stubs renderToBuffer to succeed).
  it('returns a clean 500 (not an unhandled crash) when PDF rendering fails', async () => {
    renderToBufferMock.mockRejectedValueOnce(new Error('renderToBuffer boom'));
    const res = await GET(makeReq(ID, 'invoice'), ctx());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('renderToBuffer boom');
  });
});
