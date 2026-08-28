import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const { requireOperator, getOperator, markInstallmentPaid, getSupabaseServiceClient } = vi.hoisted(() => ({
  requireOperator: vi.fn<() => Promise<unknown>>(),
  getOperator: vi.fn<() => Promise<unknown>>(),
  markInstallmentPaid: vi.fn(),
  getSupabaseServiceClient: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator, getOperator }));
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient }));
vi.mock('@/lib/installments', async () => {
  const actual = await vi.importActual<typeof import('@/lib/installments')>('@/lib/installments');
  return { ...actual, markInstallmentPaid };
});

import { POST } from './route';

type Row = { id: string; quote_id: string; seq: number; paid_at: string | null; valor_txn_id: string | null; amount_usd: number };

type Invoice = { id: string; quote_id: string | null; invoice_number: number | null; status: string; balance: number };

function db(row: Row | null, invoices: Invoice[] = []) {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, _val: unknown) =>
          table === 'invoices'
            ? Promise.resolve({ data: invoices, error: null })
            : { maybeSingle: async () => ({ data: row, error: null }) },
      }),
    }),
  };
}

const req = (body: unknown = {}): NextRequest =>
  ({ json: async () => body }) as unknown as NextRequest;

const ctx = { params: Promise.resolve({ id: 'i-4' }) };

const unpaid = (over: Partial<Row> = {}): Row => ({
  id: 'i-4',
  quote_id: 'q-1',
  seq: 4,
  paid_at: null,
  valor_txn_id: null,
  amount_usd: 453.13,
  ...over,
});

const openInvoice = (over: Partial<Invoice> = {}): Invoice => ({
  id: 'inv-1',
  quote_id: 'q-1',
  invoice_number: 1010,
  status: 'draft',
  balance: 1359.36,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  requireOperator.mockResolvedValue(null);
  getOperator.mockResolvedValue({ id: 'op-7' });
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


describe('who recorded it', () => {
  // The sibling manual invoice settle has recorded `settled_by` since #225: a
  // money write needs a WHO. This one shipped without one — premerge admin lens.
  it('records the operator who clicked', async () => {
    await POST(req(), ctx);
    expect(markInstallmentPaid).toHaveBeenCalledWith(expect.objectContaining({ paidBy: 'op-7' }));
  });

  it('records null rather than failing when the operator cannot be resolved', async () => {
    getOperator.mockResolvedValue(null);
    const res = await POST(req(), ctx);
    expect(res.status).toBe(200);
    expect(markInstallmentPaid).toHaveBeenCalledWith(expect.objectContaining({ paidBy: null }));
  });
});

describe('a linked invoice that will not move', () => {
  // Recording raises the quote's collected total; invoices.balance is a stored
  // figure nothing updates yet (row 450), so the invoice list and the owner's
  // dashboard go wrong by exactly this payment. The runner already refuses to
  // CHARGE into that state; this route must not walk into it silently either.
  // Premerge admin lens HIGH. Live today for Jane Laguerre's draft invoice #1010.
  it('refuses the first attempt and names the invoice and both figures', async () => {
    getSupabaseServiceClient.mockReturnValue(db(unpaid(), [openInvoice()]));
    const res = await POST(req(), ctx);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('invoice-would-drift');
    expect(body.error).toContain('#1010');
    expect(body.error).toContain('1359.36');
    expect(body.error).toContain('906.23');
    expect(markInstallmentPaid).not.toHaveBeenCalled();
  });

  it('records it once the operator confirms', async () => {
    getSupabaseServiceClient.mockReturnValue(db(unpaid(), [openInvoice()]));
    const res = await POST(req({ confirmInvoiceDrift: true }), ctx);
    expect(res.status).toBe(200);
    expect(markInstallmentPaid).toHaveBeenCalled();
  });

  it('does not ask when the invoice is already settled or cancelled', async () => {
    for (const status of ['paid', 'cancelled']) {
      vi.clearAllMocks();
      getOperator.mockResolvedValue({ id: 'op-7' });
      markInstallmentPaid.mockResolvedValue({ ok: true, amountUsd: 453.13 });
      getSupabaseServiceClient.mockReturnValue(db(unpaid(), [openInvoice({ status })]));
      expect((await POST(req(), ctx)).status, status).toBe(200);
    }
  });

  it('does not ask when the quote has no invoice at all', async () => {
    getSupabaseServiceClient.mockReturnValue(db(unpaid(), []));
    expect((await POST(req(), ctx)).status).toBe(200);
  });
});
