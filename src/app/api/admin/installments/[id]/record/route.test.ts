import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const { requireOperator, markInstallmentPaid, getSupabaseServiceClient } = vi.hoisted(() => ({
  requireOperator: vi.fn<() => Promise<unknown>>(),
  markInstallmentPaid: vi.fn(),
  getSupabaseServiceClient: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator }));
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient }));
vi.mock('@/lib/installments', async () => {
  const actual = await vi.importActual<typeof import('@/lib/installments')>('@/lib/installments');
  return { ...actual, markInstallmentPaid };
});

import { POST } from './route';

type Row = { id: string; paid_at: string | null; valor_txn_id: string | null; amount_usd: number };

function db(row: Row | null) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
      }),
    }),
  };
}

const req = (body: unknown = {}): NextRequest =>
  ({ json: async () => body }) as unknown as NextRequest;

const ctx = { params: Promise.resolve({ id: 'i-4' }) };

const unpaid = (over: Partial<Row> = {}): Row => ({
  id: 'i-4',
  paid_at: null,
  valor_txn_id: null,
  amount_usd: 453.13,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireOperator.mockResolvedValue(null);
  getSupabaseServiceClient.mockReturnValue(db(unpaid()));
  markInstallmentPaid.mockResolvedValue({ ok: true, amountUsd: 453.13 });
});

describe('auth and shape', () => {
  it('refuses a caller who is not an operator, and writes nothing', async () => {
    requireOperator.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(401);
    expect(markInstallmentPaid).not.toHaveBeenCalled();
  });

  it('refuses an unknown payment source rather than guessing', async () => {
    const res = await POST(req({ source: 'homeworks' }), ctx);
    expect(res.status).toBe(400);
    expect(markInstallmentPaid).not.toHaveBeenCalled();
  });

  it('404s an installment that does not exist', async () => {
    getSupabaseServiceClient.mockReturnValue(db(null));
    expect((await POST(req(), ctx)).status).toBe(404);
  });

  it('refuses to record a payment that is already paid', async () => {
    getSupabaseServiceClient.mockReturnValue(db(unpaid({ paid_at: '2026-09-05T12:00:00Z' })));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('already-paid');
    expect(markInstallmentPaid).not.toHaveBeenCalled();
  });
});

describe('the ordinary case', () => {
  it('records a cash/check payment and reports the amount', async () => {
    const res = await POST(req({ source: 'manual' }), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, amountUsd: 453.13 });
    expect(markInstallmentPaid).toHaveBeenCalledWith(
      expect.objectContaining({ installmentId: 'i-4', source: 'manual', valorTxnId: null }),
    );
  });

  it('keeps a Valor reference the operator supplies', async () => {
    await POST(req({ source: 'valor', valorTxnId: ' TXN-77 ' }), ctx);
    expect(markInstallmentPaid).toHaveBeenCalledWith(expect.objectContaining({ valorTxnId: 'TXN-77' }));
  });

  it('surfaces a refusal from markInstallmentPaid rather than reporting success', async () => {
    markInstallmentPaid.mockResolvedValue({ ok: false, error: 'Already recorded as paid' });
    expect((await POST(req(), ctx)).status).toBe(409);
  });
});

describe('an unresolved charge attempt', () => {
  // The state that exists BECAUSE the runner refuses to retry: money may have
  // moved and nobody knows. Recording it writes over an unknown, so it must
  // never be one click.
  for (const slotValue of ['pending:2026-09-05T13:00:00.000Z', 'ambiguous-timeout:2026-09-05T13:00:00.000Z', 'TXN-9911']) {
    it(`refuses the first attempt when the slot holds "${slotValue}"`, async () => {
      getSupabaseServiceClient.mockReturnValue(db(unpaid({ valor_txn_id: slotValue })));
      const res = await POST(req(), ctx);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('charge-slot-unresolved');
      expect(body.error).toContain('Check Valor');
      expect(markInstallmentPaid).not.toHaveBeenCalled();
    });
  }

  it('records it once the operator confirms they checked Valor', async () => {
    getSupabaseServiceClient.mockReturnValue(db(unpaid({ valor_txn_id: 'TXN-9911' })));
    const res = await POST(req({ confirmChargeSlot: true }), ctx);
    expect(res.status).toBe(200);
    // A REAL reference is worth keeping on the paid record.
    expect(markInstallmentPaid).toHaveBeenCalledWith(expect.objectContaining({ valorTxnId: 'TXN-9911' }));
  });

  it('never promotes an ambiguous-timeout marker into the paid record as a reference', async () => {
    getSupabaseServiceClient.mockReturnValue(
      db(unpaid({ valor_txn_id: 'ambiguous-timeout:2026-09-05T13:00:00.000Z' })),
    );
    await POST(req({ confirmChargeSlot: true }), ctx);
    expect(markInstallmentPaid).toHaveBeenCalledWith(expect.objectContaining({ valorTxnId: null }));
  });
});
