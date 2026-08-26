import { describe, it, expect, beforeEach, vi } from 'vitest';
import { type NextRequest } from 'next/server';

// Row 388 — the standalone resync action. This route's own job is thin:
// auth, load the invoice + linked quote, resolve the agreed total, and call
// the SHARED resyncInvoiceToAgreedTotal with the right arguments — the money
// math and the CAS/retry semantics are that function's own, already covered
// by quoteAmendInvoiceSync.test.ts and the /amend + /amend-decline route
// tests. These tests verify WHEN this route calls it, WITH what, and how it
// maps the outcome to a response — mirroring amend-decline/route.test.ts's
// mocking shape for the same shared call.

const {
  sbRef,
  requireOperatorMock,
  getInvoiceMock,
  getJobByQuoteMock,
  resyncInvoiceToAgreedTotalMock,
} = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getInvoiceMock: vi.fn(async (): Promise<unknown> => null),
  getJobByQuoteMock: vi.fn(async (): Promise<unknown> => null),
  resyncInvoiceToAgreedTotalMock: vi.fn(async () => ({
    invoicedBalance: 1500 as number | null,
    invoicedTotal: 2500 as number | null,
    previousInvoicedTotal: 2000 as number | null,
    resynced: true,
  })),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
}));
vi.mock('@/lib/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/invoices')>();
  return { ...actual, getInvoice: getInvoiceMock };
});
vi.mock('@/lib/jobs', () => ({ getJobByQuote: getJobByQuoteMock }));
vi.mock('@/lib/quoteAmendInvoiceSync', () => ({
  resyncInvoiceToAgreedTotal: resyncInvoiceToAgreedTotalMock,
}));

import { POST } from './route';

const INVOICE_ID = '22222222-2222-4222-8222-222222222222';
const QUOTE_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';

const RESULT = { total: 2500 } as unknown;

function makeFakeQuotes(row: { result: unknown; approval_snapshot: unknown; deposit_amount_usd: number | null } | null) {
  function from(table: string) {
    expect(table).toBe('quotes');
    return {
      select: () => ({
        eq: () => ({
          async maybeSingle() {
            return row ? { data: row, error: null } : { data: null, error: null };
          },
        }),
      }),
    };
  }
  return { from };
}

const req = () => ({}) as unknown as NextRequest;
const params = { params: Promise.resolve({ id: INVOICE_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getInvoiceMock.mockResolvedValue({ id: INVOICE_ID, quote_id: QUOTE_ID, status: 'paid', balance: 0 });
  getJobByQuoteMock.mockResolvedValue({ id: JOB_ID });
  resyncInvoiceToAgreedTotalMock.mockResolvedValue({
    invoicedBalance: 1500,
    invoicedTotal: 2500,
    previousInvoicedTotal: 2000,
    resynced: true,
  });
  sbRef.current = makeFakeQuotes({
    result: RESULT,
    approval_snapshot: { customerSelection: { currentTotalUsd: 2500 } },
    deposit_amount_usd: 1000,
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('POST /api/invoices/[id]/resync (row 388)', () => {
  it('calls resyncInvoiceToAgreedTotal with the resolved agreed total + the linked job id, and returns the outcome', async () => {
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, invoicedTotal: 2500, invoicedBalance: 1500, previousInvoicedTotal: 2000 });
    expect(resyncInvoiceToAgreedTotalMock).toHaveBeenCalledWith({
      jobId: JOB_ID,
      invoice: { id: INVOICE_ID, quote_id: QUOTE_ID, status: 'paid', balance: 0 },
      result: RESULT,
      depositPaid: 1000,
      newTotal: 2500,
      logPrefix: '[api/invoices/:id/resync]',
      retiredReason: 'manual-resync',
    });
  });

  it('resolves the agreed total from the LATEST non-declined amendment, not the raw result total', async () => {
    sbRef.current = makeFakeQuotes({
      result: { total: 3000 },
      approval_snapshot: { amendments: [{ new_total: 2700 }] },
      deposit_amount_usd: 1000,
    });
    await POST(req(), params);
    expect(resyncInvoiceToAgreedTotalMock).toHaveBeenCalledWith(
      expect.objectContaining({ newTotal: 2700 }),
    );
  });

  it('passes jobId:null when the quote has no linked job (no fresh re-read possible, matching /amend-decline)', async () => {
    getJobByQuoteMock.mockResolvedValue(null);
    await POST(req(), params);
    expect(resyncInvoiceToAgreedTotalMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: null }));
  });

  it('409s resync-failed and does NOT report ok:true when resyncInvoiceToAgreedTotal reports resynced:false', async () => {
    resyncInvoiceToAgreedTotalMock.mockResolvedValue({
      invoicedBalance: null,
      invoicedTotal: null,
      previousInvoicedTotal: null,
      resynced: false,
    });
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('resync-failed');
  });

  it('409s cancelled for a cancelled invoice, without calling the resync at all', async () => {
    getInvoiceMock.mockResolvedValue({ id: INVOICE_ID, quote_id: QUOTE_ID, status: 'cancelled', balance: 0 });
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('cancelled');
    expect(resyncInvoiceToAgreedTotalMock).not.toHaveBeenCalled();
  });

  it('409s no-quote for an invoice with no linked order', async () => {
    getInvoiceMock.mockResolvedValue({ id: INVOICE_ID, quote_id: null, status: 'paid', balance: 0 });
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no-quote');
  });

  it('409s no-pricing when the linked quote has no priced result', async () => {
    sbRef.current = makeFakeQuotes({ result: null, approval_snapshot: null, deposit_amount_usd: null });
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no-pricing');
    expect(resyncInvoiceToAgreedTotalMock).not.toHaveBeenCalled();
  });

  it('503s read-failed when the quote read fails, and writes nothing', async () => {
    sbRef.current = makeFakeQuotes(null);
    const res = await POST(req(), params);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('read-failed');
    expect(resyncInvoiceToAgreedTotalMock).not.toHaveBeenCalled();
  });

  it('404s an unknown invoice and 400s a malformed id', async () => {
    getInvoiceMock.mockResolvedValue(null);
    expect((await POST(req(), params)).status).toBe(404);
    expect((await POST(req(), { params: Promise.resolve({ id: 'not-a-uuid' }) })).status).toBe(400);
  });

  it('denies a non-operator before touching the invoice at all', async () => {
    const { NextResponse } = await import('next/server');
    requireOperatorMock.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const res = await POST(req(), params);
    expect(res.status).toBe(401);
    expect(getInvoiceMock).not.toHaveBeenCalled();
  });
});
