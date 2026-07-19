// Tests for POST /api/invoices/[id]/mark-paid (#83 ops): operator records an
// offline/external payment. The helper is mocked; only route-level concerns
// (UUID validation, auth gate, 404/409 error mapping, and the WT-18 re-consent
// settlement gate) are tested here.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { markInvoicePaidManually, getInvoice, getJob, setJobStatus, requireOperatorMock, sbRef } =
  vi.hoisted(() => ({
    markInvoicePaidManually: vi.fn(),
    getInvoice: vi.fn(),
    getJob: vi.fn(),
    setJobStatus: vi.fn(),
    requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
    sbRef: { current: null as unknown },
  }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/invoices', () => ({ markInvoicePaidManually, getInvoice }));
vi.mock('@/lib/jobs', () => ({ getJob, setJobStatus }));

import { POST } from './route';

const ID = '22222222-2222-2222-2222-222222222222';
const JOB_ID = '33333333-3333-3333-3333-333333333333';
const QUOTE_ID = '55555555-5555-5555-5555-555555555555';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
// A callable request builder: default (no body / no query) mirrors the real UI
// call site (`fetch(url, { method: 'POST' })` — no body at all), which is why
// the route's `req.json()` must tolerate a throw (empty body) via try/catch.
const req = (body: unknown = undefined, query = '') =>
  ({
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
    nextUrl: { searchParams: new URLSearchParams(query) },
  }) as unknown as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

const PAID_INVOICE = {
  id: ID,
  job_id: JOB_ID,
  quote_id: null as string | null,
  status: 'paid' as const,
  balance: 0,
  paid_at: '2026-07-01T00:00:00Z',
};

// The quotes-table read the WT-18 gate performs (approval_snapshot + status).
function makeSb(quote: Record<string, unknown> | null) {
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: () => b,
    select: () => b,
    eq: () => b,
    maybeSingle: async () => ({ data: quote, error: null }),
  });
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getInvoice.mockResolvedValue({ ...PAID_INVOICE });
  markInvoicePaidManually.mockResolvedValue(PAID_INVOICE);
  getJob.mockResolvedValue({ id: JOB_ID, status: 'requires_invoicing' });
  setJobStatus.mockResolvedValue({ id: JOB_ID, status: 'done' });
  sbRef.current = null;
});

describe('POST /api/invoices/[id]/mark-paid', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(req(), ctx());
    expect(res.status).toBe(401);
    expect(markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('400s on a bad UUID', async () => {
    const res = await POST(req(), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('404s when the invoice is not found', async () => {
    getInvoice.mockResolvedValueOnce(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
    expect(markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('409s when the invoice is cancelled (helper throws)', async () => {
    markInvoicePaidManually.mockRejectedValueOnce(
      new Error('markInvoicePaidManually: invoice x is cancelled'),
    );
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('cancelled');
  });

  it('200s with ok+paid+invoice shape on success', async () => {
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      ok: true,
      paid: true,
      invoice: { id: ID, status: 'paid', balance: 0 },
    });
    expect(markInvoicePaidManually).toHaveBeenCalledWith(ID);
  });

  it('advances the linked job to done when it is at requires_invoicing (mirrors the balance webhook)', async () => {
    getJob.mockResolvedValueOnce({ id: JOB_ID, status: 'requires_invoicing' });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(setJobStatus).toHaveBeenCalledWith(JOB_ID, 'done');
  });

  it('does not advance the job when it is not at requires_invoicing', async () => {
    getJob.mockResolvedValueOnce({ id: JOB_ID, status: 'scheduled' });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  it('succeeds with no linked job (invoice.job_id null) — no job lookup/close', async () => {
    markInvoicePaidManually.mockResolvedValueOnce({ ...PAID_INVOICE, job_id: null });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(getJob).not.toHaveBeenCalled();
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  it('still succeeds if the job-close throws — payment is already recorded (best-effort)', async () => {
    getJob.mockResolvedValueOnce({ id: JOB_ID, status: 'requires_invoicing' });
    setJobStatus.mockRejectedValueOnce(new Error('illegal transition'));
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.paid).toBe(true);
  });
});

describe('POST /api/invoices/[id]/mark-paid — WT-18 re-consent settlement gate', () => {
  beforeEach(() => {
    getInvoice.mockResolvedValue({ ...PAID_INVOICE, quote_id: QUOTE_ID });
  });

  it('409s reconsent-required after a price-INCREASING amendment', async () => {
    sbRef.current = makeSb({ approval_snapshot: { amendments: [{ delta: 500, new_total: 6000 }] }, status: 'booked' });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('reconsent-required');
    expect(markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('still blocks when a cosmetic amendment follows the pending increase', async () => {
    sbRef.current = makeSb({
      approval_snapshot: {
        amendments: [
          { delta: 500, new_total: 6000, consent: { status: 'pending' } },
          { delta: 0, previous_total: 6000, new_total: 6000 },
        ],
      },
      status: 'booked',
    });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('reconsent-required');
    expect(markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('succeeds with an operator override in the body', async () => {
    sbRef.current = makeSb({ approval_snapshot: { amendments: [{ delta: 500, new_total: 6000 }] }, status: 'booked' });
    const res = await POST(req({ overrideReconsent: true }), ctx());
    expect(res.status).toBe(200);
    expect(markInvoicePaidManually).toHaveBeenCalledWith(ID);
  });

  it('succeeds with an operator override via the ?override=true query param', async () => {
    sbRef.current = makeSb({ approval_snapshot: { amendments: [{ delta: 500, new_total: 6000 }] }, status: 'booked' });
    const res = await POST(req(undefined, 'override=true'), ctx());
    expect(res.status).toBe(200);
    expect(markInvoicePaidManually).toHaveBeenCalledWith(ID);
  });

  it('does NOT block a non-increasing (price-DECREASING) amendment', async () => {
    sbRef.current = makeSb({ approval_snapshot: { amendments: [{ delta: -500, new_total: 4500 }] }, status: 'booked' });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(markInvoicePaidManually).toHaveBeenCalledWith(ID);
  });

  it('does NOT block a zero-delta (cosmetic) amendment', async () => {
    sbRef.current = makeSb({ approval_snapshot: { amendments: [{ delta: 0, new_total: 5000 }] }, status: 'booked' });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
  });

  it('does NOT block a quote with no amendments at all', async () => {
    sbRef.current = makeSb({ approval_snapshot: { amendments: [] }, status: 'booked' });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
  });

  it('skips the gate entirely when the invoice has no linked quote', async () => {
    getInvoice.mockResolvedValueOnce({ ...PAID_INVOICE, quote_id: null });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
  });
});
