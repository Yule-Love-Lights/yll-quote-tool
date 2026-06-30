// Tests for POST /api/jobs/[id]/cancel (#83 cancellation). Cancels job + invoice +
// quote; refunds stay manual in Valor. Operator-gated; data layer mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { getJob, setJobStatus, getInvoiceByJob, setInvoiceStatus, requireOperatorMock, sbRef } =
  vi.hoisted(() => ({
    getJob: vi.fn(),
    setJobStatus: vi.fn(),
    getInvoiceByJob: vi.fn(),
    setInvoiceStatus: vi.fn(),
    requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
    sbRef: { current: null as unknown },
  }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/jobs', () => ({ getJob, setJobStatus }));
vi.mock('@/lib/invoices', () => ({ getInvoiceByJob, setInvoiceStatus }));

import { POST } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = {} as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

function fakeSb(depositPaidAt: string | null = null) {
  const updates: Record<string, unknown>[] = [];
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: () => b,
    select: () => b,
    update: (p: Record<string, unknown>) => {
      updates.push(p);
      return b;
    },
    eq: () => b,
    maybeSingle: async () => ({ data: { deposit_paid_at: depositPaidAt }, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ error: null }),
  });
  return { client: b, updates };
}

let sb: ReturnType<typeof fakeSb>;
beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getJob.mockResolvedValue({ id: ID, status: 'to_schedule', quote_id: 'q1' });
  setJobStatus.mockResolvedValue({ id: ID, status: 'cancelled' });
  getInvoiceByJob.mockResolvedValue({ id: 'inv-1', status: 'draft' });
  setInvoiceStatus.mockResolvedValue({ id: 'inv-1', status: 'cancelled' });
  sb = fakeSb();
  sbRef.current = sb.client;
});

describe('POST /api/jobs/[id]/cancel', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(req, ctx());
    expect(res.status).toBe(401);
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  it('404s when the job is missing', async () => {
    getJob.mockResolvedValueOnce(null);
    const res = await POST(req, ctx());
    expect(res.status).toBe(404);
  });

  it('409s when the job is already done (cannot cancel a completed job)', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'done', quote_id: 'q1' });
    const res = await POST(req, ctx());
    expect(res.status).toBe(409);
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  it('is a no-op when the job is already cancelled', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'cancelled', quote_id: 'q1' });
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyCancelled).toBe(true);
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  it('cancels the job, its invoice, and the quote', async () => {
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.cancelled).toBe(true);
    expect(setJobStatus).toHaveBeenCalledWith(ID, 'cancelled');
    expect(setInvoiceStatus).toHaveBeenCalledWith('inv-1', 'cancelled');
    expect(sb.updates[0]).toMatchObject({ status: 'cancelled' }); // quote
  });

  it('flags a paid invoice for a manual refund', async () => {
    getInvoiceByJob.mockResolvedValueOnce({ id: 'inv-1', status: 'paid' });
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(json.refundedInvoice).toBe(true);
    expect(setInvoiceStatus).toHaveBeenCalledWith('inv-1', 'cancelled');
  });

  it('cancels job + quote even when there is no invoice yet', async () => {
    getInvoiceByJob.mockResolvedValueOnce(null);
    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(setInvoiceStatus).not.toHaveBeenCalled();
    expect(sb.updates[0]).toMatchObject({ status: 'cancelled' }); // quote still cancelled
  });

  it('flags a DEPOSIT refund when a deposit was paid but no invoice exists yet', async () => {
    sb = fakeSb('2026-01-01T00:00:00Z'); // deposit paid
    sbRef.current = sb.client;
    getInvoiceByJob.mockResolvedValueOnce(null); // booked, not completed → no invoice
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(json.refundedDeposit).toBe(true);
    expect(json.refundNeeded).toBe(true);
    expect(setInvoiceStatus).not.toHaveBeenCalled();
  });
});
