// Tests for GET /api/pipeline/[quoteId] (#83 ops) — live pipeline record read.
// Auth gate + data layer are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { getQuoteRawMock, getJobByQuoteMock, getInvoiceByJobMock, requireOperatorMock } = vi.hoisted(() => ({
  getQuoteRawMock: vi.fn(),
  getJobByQuoteMock: vi.fn(),
  getInvoiceByJobMock: vi.fn(),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/supabase', () => ({ isSupabaseConfigured: () => true }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/quotes', () => ({ getQuoteRaw: getQuoteRawMock }));
// deriveStatus is a pure function — use the real implementation via its module
vi.mock('@/lib/quoteStatus', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/quoteStatus')>();
  return real;
});
vi.mock('@/lib/jobs', () => ({ getJobByQuote: getJobByQuoteMock }));
vi.mock('@/lib/invoices', () => ({ getInvoiceByJob: getInvoiceByJobMock }));

import { GET } from './route';

const QID = '11111111-1111-1111-1111-111111111111';
const JID = '22222222-2222-2222-2222-222222222222';
const IID = '33333333-3333-3333-3333-333333333333';

const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = {} as NextRequest;
const ctx = (quoteId = QID) => ({ params: Promise.resolve({ quoteId }) });

// A "booked" quote row (deposit_paid_at set → deriveStatus returns 'booked')
const bookedQuoteRow = {
  id: QID,
  quote_sent_at: '2024-01-01T00:00:00Z',
  customer_approved_at: '2024-01-02T00:00:00Z',
  deposit_paid_at: '2024-01-03T00:00:00Z',
  viewed_at: '2024-01-01T12:00:00Z',
  status: null,
  is_test: false,
};

// An "approved" quote row (customer_approved_at set, no deposit)
const approvedQuoteRow = {
  id: QID,
  quote_sent_at: '2024-01-01T00:00:00Z',
  customer_approved_at: '2024-01-02T00:00:00Z',
  deposit_paid_at: null,
  viewed_at: '2024-01-01T12:00:00Z',
  status: null,
  is_test: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getQuoteRawMock.mockResolvedValue(bookedQuoteRow);
  getJobByQuoteMock.mockResolvedValue({ id: JID, status: 'requires_invoicing' });
  getInvoiceByJobMock.mockResolvedValue({ id: IID, status: 'awaiting_payment', balance: 500 });
});

describe('GET /api/pipeline/[quoteId]', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await GET(req, ctx());
    expect(res.status).toBe(401);
    expect(getQuoteRawMock).not.toHaveBeenCalled();
  });

  it('400s on a non-UUID quoteId', async () => {
    const res = await GET(req, ctx('not-a-uuid'));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/invalid/i);
  });

  it('404s when the quote does not exist', async () => {
    getQuoteRawMock.mockResolvedValueOnce(null);
    const res = await GET(req, ctx());
    expect(res.status).toBe(404);
  });

  it('returns full pipeline record for a booked quote with job + unpaid invoice', async () => {
    const res = await GET(req, ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      quoteId: QID,
      quoteStatus: 'booked',
      isTest: false,
      depositPaid: true,
      job: { id: JID, status: 'requires_invoicing' },
      invoice: { id: IID, status: 'awaiting_payment', balance: 500 },
    });
  });

  it('returns job:null and invoice:null for an approved quote with no job', async () => {
    getQuoteRawMock.mockResolvedValueOnce(approvedQuoteRow);
    getJobByQuoteMock.mockResolvedValueOnce(null);
    const res = await GET(req, ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      quoteId: QID,
      quoteStatus: 'approved',
      isTest: false,
      depositPaid: false,
      job: null,
      invoice: null,
    });
  });

  it('does not fetch invoice when there is no job', async () => {
    getQuoteRawMock.mockResolvedValueOnce(approvedQuoteRow);
    getJobByQuoteMock.mockResolvedValueOnce(null);
    await GET(req, ctx());
    expect(getInvoiceByJobMock).not.toHaveBeenCalled();
  });

  // #176 — the record must expose view_only so PipelineActionsMenu can
  // suppress the customer-state-changing offers on a browse-only quote.
  it('threads viewOnly through from the quote row', async () => {
    getQuoteRawMock.mockResolvedValueOnce({ ...approvedQuoteRow, view_only: true });
    const res = await GET(req, ctx());
    const json = await res.json();
    expect(json.viewOnly).toBe(true);
  });

  it('defaults viewOnly to false when the row lacks it', async () => {
    const res = await GET(req, ctx()); // bookedQuoteRow has no view_only field
    const json = await res.json();
    expect(json.viewOnly).toBe(false);
  });

  // Row 340: a revive (declined/abandoned -> sent) reseeds the customer's
  // portal from whatever browsing_selection they saved before declining, with
  // no staff visibility. staleBrowsingSelection surfaces that so
  // PipelineActionsMenu can warn the operator before Send.
  describe('staleBrowsingSelection (row 340)', () => {
    it('summarizes a lettered-package browsing selection on a DECLINED quote', async () => {
      getQuoteRawMock.mockResolvedValueOnce({
        ...approvedQuoteRow,
        customer_approved_at: null,
        status: 'declined',
        browsing_selection: { packageId: 'B', selectedItemIds: ['a', 'b'] },
        browsing_selection_updated_at: '2026-08-01T00:00:00Z',
      });
      const res = await GET(req, ctx());
      const json = await res.json();
      expect(json.quoteStatus).toBe('declined');
      expect(json.staleBrowsingSelection).toEqual({
        packageId: 'B',
        itemCount: 2,
        savedAt: '2026-08-01T00:00:00Z',
      });
    });

    it('summarizes a custom (packageId D) browsing selection on an ABANDONED quote', async () => {
      getQuoteRawMock.mockResolvedValueOnce({
        ...approvedQuoteRow,
        customer_approved_at: null,
        status: 'abandoned',
        browsing_selection: { packageId: 'D', selectedItemIds: ['x', 'y', 'z'] },
        browsing_selection_updated_at: '2026-08-02T00:00:00Z',
      });
      const res = await GET(req, ctx());
      const json = await res.json();
      expect(json.quoteStatus).toBe('abandoned');
      expect(json.staleBrowsingSelection).toEqual({
        packageId: 'D',
        itemCount: 3,
        savedAt: '2026-08-02T00:00:00Z',
      });
    });

    it('is null when the quote is declined but has no saved browsing selection', async () => {
      getQuoteRawMock.mockResolvedValueOnce({
        ...approvedQuoteRow,
        customer_approved_at: null,
        status: 'declined',
        browsing_selection: null,
      });
      const res = await GET(req, ctx());
      const json = await res.json();
      expect(json.staleBrowsingSelection).toBeNull();
    });

    // Positive-match seam gate (AGENTS.md): a leftover browsing_selection on
    // any status OTHER than declined/abandoned is a live quote's real,
    // in-progress selection — not this feature's concern — and must never
    // surface as "stale."
    it('is null for a non-terminal-browse status even with a browsing_selection present', async () => {
      getQuoteRawMock.mockResolvedValueOnce({
        ...approvedQuoteRow,
        status: 'sent',
        quote_sent_at: '2024-01-01T00:00:00Z',
        customer_approved_at: null,
        viewed_at: null,
        browsing_selection: { packageId: 'B', selectedItemIds: ['a'] },
        browsing_selection_updated_at: '2026-08-01T00:00:00Z',
      });
      const res = await GET(req, ctx());
      const json = await res.json();
      expect(json.quoteStatus).toBe('sent');
      expect(json.staleBrowsingSelection).toBeNull();
    });

    it('is null when the row lacks browsing_selection entirely (back-compat)', async () => {
      const res = await GET(req, ctx()); // bookedQuoteRow has no browsing_selection field
      const json = await res.json();
      expect(json.staleBrowsingSelection).toBeNull();
    });
  });
});
