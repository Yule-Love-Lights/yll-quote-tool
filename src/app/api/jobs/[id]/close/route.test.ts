// Tests for POST /api/jobs/[id]/close (#83 ops): finalize a job — settle the
// linked invoice if unpaid, then advance the job to done. Operator-gated.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { getJob, setJobStatus, getInvoiceByJob, markInvoicePaidManually, requireOperatorMock } =
  vi.hoisted(() => ({
    getJob: vi.fn(),
    setJobStatus: vi.fn(),
    getInvoiceByJob: vi.fn(),
    markInvoicePaidManually: vi.fn(),
    requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  }));

vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/jobs', () => ({ getJob, setJobStatus }));
vi.mock('@/lib/invoices', () => ({ getInvoiceByJob, markInvoicePaidManually }));

import { POST } from './route';

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

  it('advances from to_schedule through all legal steps to done', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule' as const });
    getInvoiceByJob.mockResolvedValueOnce(null);

    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(setJobStatus).toHaveBeenCalledWith(ID, 'installed');
    expect(setJobStatus).toHaveBeenCalledWith(ID, 'requires_invoicing');
    expect(setJobStatus).toHaveBeenCalledWith(ID, 'done');
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
