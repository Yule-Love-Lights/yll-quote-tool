// Tests for POST /api/invoices/[id]/mark-paid (#83 ops): operator records an
// offline/external payment. The helper is mocked; only route-level concerns
// (UUID validation, auth gate, 404/409 error mapping, and the WT-18 re-consent
// settlement gate) are tested here.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { markInvoicePaidManually, updateInvoicePaymentReference, getInvoice, getJob, setJobStatus, requireOperatorMock, sbRef } =
  vi.hoisted(() => ({
    markInvoicePaidManually: vi.fn(),
    updateInvoicePaymentReference: vi.fn(),
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
// #199 F2: importOriginal keeps InvoiceSettleError (the real class, needed for
// the route's `instanceof` check) — only the DB-touching fns are mocked.
vi.mock('@/lib/invoices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices')>()),
  markInvoicePaidManually,
  updateInvoicePaymentReference,
  getInvoice,
}));
vi.mock('@/lib/jobs', () => ({ getJob, setJobStatus }));

import { POST } from './route';
import { InvoiceSettleError } from '@/lib/invoices';

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
  updateInvoicePaymentReference.mockResolvedValue(PAID_INVOICE);
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

  // #199 F2 (wrap-review HIGH): the mark-paid data layer refuses a cash_check/
  // omitted-method settle on an NCE-linked invoice (a single gate covering
  // both this route's back-compat default AND PipelineActionsMenu's
  // "collect-payment" empty-body POST) — the route must surface THAT specific
  // reason, not fall through to the generic 'cancelled' message.
  it('409s (nce-mismatch) with an actionable message when the helper refuses an NCE cash-settle', async () => {
    markInvoicePaidManually.mockRejectedValueOnce(
      new InvoiceSettleError('nce-mismatch', "invoice i1's quote is NCE — refusing a cash_check settle"),
    );
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('nce-mismatch');
    expect(json.error).toMatch(/Mark paid . NCE/);
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
    // #199: back-compat default — a body-less request keeps writing exactly
    // what it always wrote (now just also labelled 'cash_check'/null).
    expect(markInvoicePaidManually).toHaveBeenCalledWith(ID, 'cash_check', null);
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
    expect(markInvoicePaidManually).toHaveBeenCalledWith(ID, 'cash_check', null);
  });

  it('succeeds with an operator override via the ?override=true query param', async () => {
    sbRef.current = makeSb({ approval_snapshot: { amendments: [{ delta: 500, new_total: 6000 }] }, status: 'booked' });
    const res = await POST(req(undefined, 'override=true'), ctx());
    expect(res.status).toBe(200);
    expect(markInvoicePaidManually).toHaveBeenCalledWith(ID, 'cash_check', null);
  });

  it('does NOT block a non-increasing (price-DECREASING) amendment', async () => {
    sbRef.current = makeSb({ approval_snapshot: { amendments: [{ delta: -500, new_total: 4500 }] }, status: 'booked' });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(markInvoicePaidManually).toHaveBeenCalledWith(ID, 'cash_check', null);
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

describe('POST /api/invoices/[id]/mark-paid — NCE method/reference (#199)', () => {
  it('400s (reference-required) when method is nce with no reference', async () => {
    const res = await POST(req({ method: 'nce' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('reference-required');
    expect(markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('400s (reference-required) when the reference is whitespace-only', async () => {
    const res = await POST(req({ method: 'nce', reference: '   ' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('reference-required');
    expect(markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('400s (reference-too-long) when the reference exceeds 200 characters', async () => {
    const res = await POST(req({ method: 'nce', reference: 'x'.repeat(201) }), ctx());
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('reference-too-long');
    expect(markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('marks paid with method nce + a trimmed reference', async () => {
    const res = await POST(req({ method: 'nce', reference: '  NCE-4821  ' }), ctx());
    expect(res.status).toBe(200);
    expect(markInvoicePaidManually).toHaveBeenCalledWith(ID, 'nce', 'NCE-4821');
  });

  it('defaults to cash_check with a null reference when method is omitted (back-compat)', async () => {
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(markInvoicePaidManually).toHaveBeenCalledWith(ID, 'cash_check', null);
  });

  it('treats an unrecognized method value as cash_check (back-compat)', async () => {
    const res = await POST(req({ method: 'bogus' }), ctx());
    expect(res.status).toBe(200);
    expect(markInvoicePaidManually).toHaveBeenCalledWith(ID, 'cash_check', null);
  });
});

describe('POST /api/invoices/[id]/mark-paid — updateReferenceOnly (#199)', () => {
  it('409s (not-nce-paid) when the invoice is not yet paid', async () => {
    getInvoice.mockResolvedValueOnce({ ...PAID_INVOICE, status: 'awaiting_payment', paid_method: 'nce' });
    const res = await POST(req({ updateReferenceOnly: true, reference: 'NCE-1' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('not-nce-paid');
    expect(updateInvoicePaymentReference).not.toHaveBeenCalled();
  });

  it('409s (not-nce-paid) when the invoice was paid via cash/check, not NCE', async () => {
    getInvoice.mockResolvedValueOnce({ ...PAID_INVOICE, status: 'paid', paid_method: 'cash_check' });
    const res = await POST(req({ updateReferenceOnly: true, reference: 'NCE-1' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('not-nce-paid');
    expect(updateInvoicePaymentReference).not.toHaveBeenCalled();
  });

  it('400s (reference-required) with an empty reference', async () => {
    getInvoice.mockResolvedValueOnce({ ...PAID_INVOICE, status: 'paid', paid_method: 'nce' });
    const res = await POST(req({ updateReferenceOnly: true, reference: '' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('reference-required');
  });

  it('400s (reference-too-long) with a reference over 200 characters', async () => {
    getInvoice.mockResolvedValueOnce({ ...PAID_INVOICE, status: 'paid', paid_method: 'nce' });
    const res = await POST(req({ updateReferenceOnly: true, reference: 'x'.repeat(201) }), ctx());
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('reference-too-long');
  });

  it('updates the reference on a paid NCE invoice, trimmed', async () => {
    getInvoice.mockResolvedValueOnce({ ...PAID_INVOICE, status: 'paid', paid_method: 'nce' });
    updateInvoicePaymentReference.mockResolvedValueOnce({ ...PAID_INVOICE, status: 'paid', payment_reference: 'NCE-99' });
    const res = await POST(req({ updateReferenceOnly: true, reference: '  NCE-99  ' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(updateInvoicePaymentReference).toHaveBeenCalledWith(ID, 'NCE-99');
  });

  it('never calls markInvoicePaidManually on the reference-only path (no settlement)', async () => {
    getInvoice.mockResolvedValueOnce({ ...PAID_INVOICE, status: 'paid', paid_method: 'nce' });
    await POST(req({ updateReferenceOnly: true, reference: 'NCE-1' }), ctx());
    expect(markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('500s (update-failed) when the data-layer write fails', async () => {
    getInvoice.mockResolvedValueOnce({ ...PAID_INVOICE, status: 'paid', paid_method: 'nce' });
    updateInvoicePaymentReference.mockResolvedValueOnce(null);
    const res = await POST(req({ updateReferenceOnly: true, reference: 'NCE-1' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(json.code).toBe('update-failed');
  });

  it('skips the WT-18 reconsent gate entirely (no settlement, nothing to re-consent to)', async () => {
    getInvoice.mockResolvedValueOnce({
      ...PAID_INVOICE,
      status: 'paid',
      paid_method: 'nce',
      quote_id: QUOTE_ID,
    });
    // A pending price-increase amendment would 409 the SETTLEMENT path (see
    // the WT-18 describe block above) — the reference-only path must ignore it.
    sbRef.current = makeSb({ approval_snapshot: { amendments: [{ delta: 500, new_total: 6000 }] }, status: 'booked' });
    const res = await POST(req({ updateReferenceOnly: true, reference: 'NCE-1' }), ctx());
    expect(res.status).toBe(200);
  });
});
