// Tests for POST /api/invoices/[id]/mark-paid (#83 ops): operator records an
// offline/external payment. The helper is mocked; only route-level concerns
// (UUID validation, auth gate, 404/409 error mapping) are tested here.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { markInvoicePaidManually, getJob, setJobStatus, requireOperatorMock } = vi.hoisted(() => ({
  markInvoicePaidManually: vi.fn(),
  getJob: vi.fn(),
  setJobStatus: vi.fn(),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/invoices', () => ({ markInvoicePaidManually }));
vi.mock('@/lib/jobs', () => ({ getJob, setJobStatus }));

import { POST } from './route';

const ID = '22222222-2222-2222-2222-222222222222';
const JOB_ID = '33333333-3333-3333-3333-333333333333';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = {} as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

const PAID_INVOICE = {
  id: ID,
  job_id: JOB_ID,
  status: 'paid' as const,
  balance: 0,
  paid_at: '2026-07-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  markInvoicePaidManually.mockResolvedValue(PAID_INVOICE);
  getJob.mockResolvedValue({ id: JOB_ID, status: 'requires_invoicing' });
  setJobStatus.mockResolvedValue({ id: JOB_ID, status: 'done' });
});

describe('POST /api/invoices/[id]/mark-paid', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(req, ctx());
    expect(res.status).toBe(401);
    expect(markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('400s on a bad UUID', async () => {
    const res = await POST(req, ctx('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(markInvoicePaidManually).not.toHaveBeenCalled();
  });

  it('404s when the invoice is not found (helper returns null)', async () => {
    markInvoicePaidManually.mockResolvedValueOnce(null);
    const res = await POST(req, ctx());
    expect(res.status).toBe(404);
  });

  it('409s when the invoice is cancelled (helper throws)', async () => {
    markInvoicePaidManually.mockRejectedValueOnce(
      new Error('markInvoicePaidManually: invoice x is cancelled'),
    );
    const res = await POST(req, ctx());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.code).toBe('cancelled');
  });

  it('200s with ok+paid+invoice shape on success', async () => {
    const res = await POST(req, ctx());
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
    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(setJobStatus).toHaveBeenCalledWith(JOB_ID, 'done');
  });

  it('does not advance the job when it is not at requires_invoicing', async () => {
    getJob.mockResolvedValueOnce({ id: JOB_ID, status: 'scheduled' });
    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  it('succeeds with no linked job (invoice.job_id null) — no job lookup/close', async () => {
    markInvoicePaidManually.mockResolvedValueOnce({ ...PAID_INVOICE, job_id: null });
    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(getJob).not.toHaveBeenCalled();
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  it('still succeeds if the job-close throws — payment is already recorded (best-effort)', async () => {
    getJob.mockResolvedValueOnce({ id: JOB_ID, status: 'requires_invoicing' });
    setJobStatus.mockRejectedValueOnce(new Error('illegal transition'));
    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.paid).toBe(true);
  });
});
