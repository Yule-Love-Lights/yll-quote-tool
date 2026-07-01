// Tests for POST /api/invoices/[id]/mark-paid (#83 ops): operator records an
// offline/external payment. The helper is mocked; only route-level concerns
// (UUID validation, auth gate, 404/409 error mapping) are tested here.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { markInvoicePaidManually, requireOperatorMock } = vi.hoisted(() => ({
  markInvoicePaidManually: vi.fn(),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/invoices', () => ({ markInvoicePaidManually }));

import { POST } from './route';

const ID = '22222222-2222-2222-2222-222222222222';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = {} as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

const PAID_INVOICE = {
  id: ID,
  status: 'paid' as const,
  balance: 0,
  paid_at: '2026-07-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  markInvoicePaidManually.mockResolvedValue(PAID_INVOICE);
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
});
