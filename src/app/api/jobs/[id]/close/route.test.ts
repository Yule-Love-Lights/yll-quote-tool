// Tests for POST /api/jobs/[id]/close (#83 ops): finalize a job — settle the
// linked invoice if unpaid, then advance the job to done. Operator-gated.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { getJob, setJobStatus, getInvoiceByJob, markInvoicePaidManually, requireOperatorMock, sbRef, hl } =
  vi.hoisted(() => ({
    getJob: vi.fn(),
    setJobStatus: vi.fn(),
    getInvoiceByJob: vi.fn(),
    markInvoicePaidManually: vi.fn(),
    requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
    sbRef: { current: null as unknown },
    hl: {
      configured: { value: false },
      updateOpportunity: vi.fn(async () => ({ id: 'opp_1' })),
      findOpportunityForContact: vi.fn(async () => null as { id: string } | null),
    },
  }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  // Consumed by the shared moveQuoteCardToInstalled helper (ghlQuoteCard.ts);
  // null (the default) makes the helper a silent no-op for the non-GHL tests.
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/jobs', () => ({ getJob, setJobStatus }));
vi.mock('@/lib/invoices', () => ({ getInvoiceByJob, markInvoicePaidManually }));
vi.mock('@/lib/integrations/highlevel', () => ({
  isHighLevelConfigured: () => hl.configured.value,
  updateOpportunity: hl.updateOpportunity,
  findOpportunityForContact: hl.findOpportunityForContact,
  HighLevelError: class HighLevelError extends Error {},
}));

import { POST } from './route';

// A minimal from().select().eq().maybeSingle() chain for the quote row the
// installed-stage GHL move reads (the shared moveQuoteCardToInstalled in
// src/lib/integrations/ghlQuoteCard.ts).
function makeQuoteSb(quote: Record<string, unknown> | null) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: quote, error: null }),
  });
  return builder;
}

const ID = '33333333-3333-3333-3333-333333333333';
const INV_ID = '44444444-4444-4444-4444-444444444444';

const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = {} as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

const JOB_REQUIRES_INVOICING = { id: ID, status: 'requires_invoicing' as const };
const JOB_DONE = { id: ID, status: 'done' as const };
const JOB_CANCELLED = { id: ID, status: 'cancelled' as const };

const UNPAID_INVOICE = { id: INV_ID, status: 'awaiting_payment' as const, balance: 500 };
const PAID_INVOICE = { id: INV_ID, status: 'paid' as const, balance: 0 };

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getInvoiceByJob.mockResolvedValue(null);
  markInvoicePaidManually.mockResolvedValue(PAID_INVOICE);
  setJobStatus.mockImplementation(async (_id: string, to: string) => ({ id: ID, status: to }));
  hl.configured.value = false;
  sbRef.current = null; // moveQuoteCardToInstalled no-ops without a service client
});

describe('POST /api/jobs/[id]/close', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(req, ctx());
    expect(res.status).toBe(401);
    expect(getJob).not.toHaveBeenCalled();
  });

  it('400s on a bad UUID', async () => {
    const res = await POST(req, ctx('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(getJob).not.toHaveBeenCalled();
  });

  it('404s when the job does not exist', async () => {
    getJob.mockResolvedValueOnce(null);
    const res = await POST(req, ctx());
    expect(res.status).toBe(404);
  });

  it('400s when the job is cancelled', async () => {
    getJob.mockResolvedValueOnce(JOB_CANCELLED);
    const res = await POST(req, ctx());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.code).toBe('cancelled');
    expect(markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('200 alreadyDone when the job is already done — no writes', async () => {
    getJob.mockResolvedValueOnce(JOB_DONE);
    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, alreadyDone: true });
    expect(markInvoicePaidManually).not.toHaveBeenCalled();
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  it('marks the invoice paid + advances to done when requires_invoicing + unpaid invoice', async () => {
    getJob.mockResolvedValueOnce(JOB_REQUIRES_INVOICING);
    getInvoiceByJob.mockResolvedValueOnce(UNPAID_INVOICE);

    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, closed: true });

    expect(markInvoicePaidManually).toHaveBeenCalledWith(INV_ID);
    expect(setJobStatus).toHaveBeenCalledWith(ID, 'done');
  });

  it('does NOT re-mark the invoice when it is already paid, still advances to done', async () => {
    getJob.mockResolvedValueOnce(JOB_REQUIRES_INVOICING);
    getInvoiceByJob.mockResolvedValueOnce(PAID_INVOICE);

    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(markInvoicePaidManually).not.toHaveBeenCalled();
    expect(setJobStatus).toHaveBeenCalledWith(ID, 'done');
  });

  it('advances from to_schedule through all legal steps to done (when an invoice exists)', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule' as const });
    getInvoiceByJob.mockResolvedValueOnce(PAID_INVOICE);

    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(setJobStatus).toHaveBeenCalledWith(ID, 'installed');
    expect(setJobStatus).toHaveBeenCalledWith(ID, 'requires_invoicing');
    expect(setJobStatus).toHaveBeenCalledWith(ID, 'done');
  });

  it('409s no-invoice: refuses to close a to_schedule job with NO invoice (would forfeit the balance)', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule' as const });
    getInvoiceByJob.mockResolvedValueOnce(null);

    const res = await POST(req, ctx());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('no-invoice');
    // Must not advance the job or silently finalize without an invoice.
    expect(setJobStatus).not.toHaveBeenCalled();
    expect(markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('409s no-invoice: refuses to close a requires_invoicing job with NO invoice', async () => {
    getJob.mockResolvedValueOnce(JOB_REQUIRES_INVOICING);
    getInvoiceByJob.mockResolvedValueOnce(null);

    const res = await POST(req, ctx());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('no-invoice');
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  it('409s when markInvoicePaidManually throws (cancelled invoice)', async () => {
    getJob.mockResolvedValueOnce(JOB_REQUIRES_INVOICING);
    getInvoiceByJob.mockResolvedValueOnce(UNPAID_INVOICE);
    markInvoicePaidManually.mockRejectedValueOnce(new Error('invoice is cancelled'));

    const res = await POST(req, ctx());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('settle-failed');
  });
});

describe('POST /api/jobs/[id]/close — GHL installed-stage card move (#GHL pipeline sync)', () => {
  beforeEach(() => {
    hl.configured.value = true;
    // Thread quote_id through the transitions so the helper can find the quote
    // (mirrors the real setJobStatus, which returns the full updated row).
    setJobStatus.mockImplementation(async (_id: string, to: string) => ({ id: ID, status: to, quote_id: 'quote-1' }));
  });

  it('a close from to_schedule (bypassing /complete) STILL moves the card to Installed', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule' as const, quote_id: 'quote-1' });
    getInvoiceByJob.mockResolvedValueOnce(PAID_INVOICE);
    sbRef.current = makeQuoteSb({
      id: 'quote-1',
      highlevel_opportunity_id: 'opp_1',
      highlevel_contact_id: 'contact_1',
      service_type: 'permanent',
      is_test: false,
    });

    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).closed).toBe(true);
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp_1', {
      pipelineStageId: 'b2192f2e-eee9-4a1b-9749-4f458f007c55', // permanent Installed
    });
  });

  it('does NOT move the card when closing a job already at requires_invoicing (no installed transition here)', async () => {
    getJob.mockResolvedValueOnce({ ...JOB_REQUIRES_INVOICING, quote_id: 'quote-1' });
    getInvoiceByJob.mockResolvedValueOnce(PAID_INVOICE);
    sbRef.current = makeQuoteSb({
      id: 'quote-1',
      highlevel_opportunity_id: 'opp_1',
      service_type: 'holiday',
      is_test: false,
    });

    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });

  it('never touches GHL for a TEST quote', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule' as const, quote_id: 'quote-1' });
    getInvoiceByJob.mockResolvedValueOnce(PAID_INVOICE);
    sbRef.current = makeQuoteSb({
      id: 'quote-1',
      highlevel_opportunity_id: 'opp_1',
      service_type: 'holiday',
      is_test: true,
    });

    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });

  it('does NOT fail the close when the GHL stage move throws (fail-open)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    hl.updateOpportunity.mockRejectedValueOnce(new Error('GHL down'));
    getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule' as const, quote_id: 'quote-1' });
    getInvoiceByJob.mockResolvedValueOnce(PAID_INVOICE);
    sbRef.current = makeQuoteSb({
      id: 'quote-1',
      highlevel_opportunity_id: 'opp_1',
      service_type: 'holiday',
      is_test: false,
    });

    const res = await POST(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.closed).toBe(true);
    // The job still advanced all the way to done despite the GHL failure.
    expect(setJobStatus).toHaveBeenCalledWith(ID, 'done');
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('GHL installed stage move failed'),
      expect.anything(),
    );
    err.mockRestore();
  });
});
