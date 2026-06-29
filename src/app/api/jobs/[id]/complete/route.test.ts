// Tests for POST /api/jobs/[id]/complete (#83): advance the job to
// requires_invoicing + auto-create its invoice; settle when the deposit covers
// the total. Operator-gated; the auth gate + data layer are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { getJob, setJobStatus, createInvoiceFromJob, setInvoiceStatus, requireOperatorMock } =
  vi.hoisted(() => ({
    getJob: vi.fn(),
    setJobStatus: vi.fn(),
    createInvoiceFromJob: vi.fn(),
    setInvoiceStatus: vi.fn(),
    requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  }));

vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/jobs', () => ({ getJob, setJobStatus }));
vi.mock('@/lib/invoices', () => ({ createInvoiceFromJob, setInvoiceStatus }));

import { POST } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = {} as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

const INVOICE = {
  id: 'inv-1',
  invoice_number: 1000,
  total: 1000,
  deposit_applied: 500,
  balance: 500,
  credit_note: 0,
  status: 'draft' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  // Default: setJobStatus echoes the target status so the advance helper threads.
  setJobStatus.mockImplementation(async (_id: string, to: string) => ({ id: ID, status: to }));
  createInvoiceFromJob.mockResolvedValue(INVOICE);
  setInvoiceStatus.mockResolvedValue({ ...INVOICE, status: 'paid' });
});

describe('POST /api/jobs/[id]/complete', () => {
  it('401s when the operator gate denies — never touches the data layer', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(req, ctx());
    expect(res.status).toBe(401);
    expect(getJob).not.toHaveBeenCalled();
  });

  it('400s on an invalid job id', async () => {
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
    getJob.mockResolvedValueOnce({ id: ID, status: 'cancelled' });
    const res = await POST(req, ctx());
    expect(res.status).toBe(400);
    expect(createInvoiceFromJob).not.toHaveBeenCalled();
  });

  it('advances to_schedule → installed → requires_invoicing and creates the invoice (balance > 0, not settled)', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule' });
    const res = await POST(req, ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(setJobStatus).toHaveBeenNthCalledWith(1, ID, 'installed');
    expect(setJobStatus).toHaveBeenNthCalledWith(2, ID, 'requires_invoicing');
    expect(createInvoiceFromJob).toHaveBeenCalledWith(ID);
    expect(json).toMatchObject({ ok: true, settled: false });
    expect(json.invoice).toMatchObject({ balance: 500, status: 'draft' });
    expect(setInvoiceStatus).not.toHaveBeenCalled();
  });

  it('does not re-advance a job already at requires_invoicing', async () => {
    getJob.mockResolvedValue({ id: ID, status: 'requires_invoicing' });
    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    // setJobStatus only ever called for the (later) done transition, never to advance.
    expect(setJobStatus).not.toHaveBeenCalledWith(ID, 'installed');
  });

  it('settles paid + closes the job when the deposit covers the total (balance ≤ 0)', async () => {
    getJob.mockResolvedValue({ id: ID, status: 'requires_invoicing' });
    createInvoiceFromJob.mockResolvedValueOnce({ ...INVOICE, balance: 0, status: 'draft' });
    const res = await POST(req, ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(setInvoiceStatus).toHaveBeenCalledWith('inv-1', 'paid');
    expect(setJobStatus).toHaveBeenCalledWith(ID, 'done');
    expect(json).toMatchObject({ ok: true, settled: true });
    expect(json.invoice.status).toBe('paid');
  });

  it('409s when the job has no quote to invoice', async () => {
    getJob.mockResolvedValue({ id: ID, status: 'requires_invoicing' });
    createInvoiceFromJob.mockResolvedValueOnce(null);
    const res = await POST(req, ctx());
    expect(res.status).toBe(409);
  });
});
