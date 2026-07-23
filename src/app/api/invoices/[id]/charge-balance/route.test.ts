// Tests for POST /api/invoices/[id]/charge-balance (#83). Operator-triggered
// card-on-file charge of the invoice balance, gated behind VALOR_AUTO_CHARGE_ENABLED.
// Valor seam, invoices, jobs, supabase, and auth are mocked; planBalanceCollection is real.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { type NextRequest } from 'next/server';

const {
  sbRef,
  requireOperatorMock,
  getInvoiceMock,
  markPaidMock,
  getJobMock,
  setJobStatusMock,
  chargeMock,
  isAutoChargeEnabledMock,
} = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getInvoiceMock: vi.fn(async (): Promise<unknown> => null),
  markPaidMock: vi.fn(async (): Promise<unknown> => ({ id: 'inv-1', status: 'paid', balance: 0, job_id: 'job-1' })),
  getJobMock: vi.fn(async (): Promise<unknown> => ({ id: 'job-1', status: 'requires_invoicing' })),
  setJobStatusMock: vi.fn(async (): Promise<unknown> => ({ id: 'job-1', status: 'done' })),
  chargeMock: vi.fn(async (): Promise<unknown> => ({ ok: true, chargedUsd: 2500, txnId: 'txn-9', approvalCode: 'A1', receiptUrl: 'r', raw: {} })),
  isAutoChargeEnabledMock: vi.fn(() => true),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/invoices', () => ({ getInvoice: getInvoiceMock, markInvoicePaidManually: markPaidMock }));
vi.mock('@/lib/jobs', () => ({ getJob: getJobMock, setJobStatus: setJobStatusMock }));
vi.mock('@/lib/integrations/valorBalance', () => ({
  chargeBalanceOnFile: chargeMock,
  isAutoChargeEnabled: isAutoChargeEnabledMock,
}));

import { POST } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const QID = '22222222-2222-2222-2222-222222222222';
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

type InvoiceUpdateCall = {
  patch: Record<string, unknown>;
  eqs: [string, unknown][];
  isCalls: [string, unknown][];
};
type InvoiceUpdateResult = { data?: unknown; error?: unknown };

// A per-table-aware mock: 'quotes' keeps the original select().eq().single()
// chain; 'invoices' supports update(patch).eq(...).is(...).select(...) in any
// order/count, records every call (for asserting the idempotency claim/release
// CAS shape), and resolves to a QUEUED result per call (default: a successful
// 1-row update) so existing tests that never touch the queue keep working.
function makeSb(quote: Record<string, unknown> | null, invoiceResponses: InvoiceUpdateResult[] = []) {
  const invoiceCalls: InvoiceUpdateCall[] = [];
  let invoiceCallIdx = 0;

  const quotesChain: Record<string, unknown> = {};
  Object.assign(quotesChain, {
    select: () => quotesChain,
    eq: () => quotesChain,
    single: async () => ({ data: quote, error: quote ? null : { message: 'no rows' } }),
  });

  function makeInvoiceChain(patch: Record<string, unknown>) {
    const call: InvoiceUpdateCall = { patch, eqs: [], isCalls: [] };
    invoiceCalls.push(call);
    const idx = invoiceCallIdx++;
    const resolveResult = (): InvoiceUpdateResult => invoiceResponses[idx] ?? { data: [{ id: 'inv-row' }], error: null };
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      eq: (col: string, val: unknown) => {
        call.eqs.push([col, val]);
        return chain;
      },
      is: (col: string, val: unknown) => {
        call.isCalls.push([col, val]);
        return chain;
      },
      select: () => Promise.resolve(resolveResult()),
      then: (onFulfilled: (v: InvoiceUpdateResult) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(resolveResult()).then(onFulfilled, onRejected),
    });
    return chain;
  }

  const invoicesTable = { update: (patch: Record<string, unknown>) => makeInvoiceChain(patch) };
  const b = {
    from: (table: string) => (table === 'quotes' ? quotesChain : invoicesTable),
    _invoiceCalls: invoiceCalls,
  };
  return b;
}

// Typed accessor for the recorded invoices-table update calls (claim/reclaim/
// release/final-record), used to assert the idempotency CAS shape.
function invoiceCallsOf(sb: unknown): InvoiceUpdateCall[] {
  return (sb as { _invoiceCalls: InvoiceUpdateCall[] })._invoiceCalls;
}

const INVOICE = {
  id: ID,
  quote_id: QID,
  job_id: 'job-1',
  status: 'awaiting_payment',
  balance: 2500,
  credit_note: 0,
  valor_balance_txn_id: null as string | null,
};
const QUOTE = {
  valor_vault_token: 'vault-token-abc',
  customer_name: 'Alice',
  customer_email: 'a@x.com',
  approval_snapshot: { amendments: [] as unknown[] },
  status: 'booked',
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  isAutoChargeEnabledMock.mockReturnValue(true);
  getInvoiceMock.mockResolvedValue({ ...INVOICE });
  markPaidMock.mockResolvedValue({ id: ID, status: 'paid', balance: 0, job_id: 'job-1' });
  getJobMock.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
  setJobStatusMock.mockResolvedValue({ id: 'job-1', status: 'done' });
  chargeMock.mockResolvedValue({ ok: true, chargedUsd: 2500, txnId: 'txn-9', approvalCode: 'A1', receiptUrl: 'r', raw: {} });
  sbRef.current = makeSb(QUOTE);
});

describe('POST /api/invoices/[id]/charge-balance', () => {
  it('returns the operator gate response when denied', async () => {
    const denied = { status: 401 };
    requireOperatorMock.mockResolvedValueOnce(denied);
    const res = await POST(req(), ctx());
    expect(res).toBe(denied);
    expect(chargeMock).not.toHaveBeenCalled();
  });

  it('503s (not-enabled) when the auto-charge flag is off, without touching the invoice', async () => {
    isAutoChargeEnabledMock.mockReturnValueOnce(false);
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(503);
    expect(json.reason).toBe('not-enabled');
    expect(getInvoiceMock).not.toHaveBeenCalled();
    expect(chargeMock).not.toHaveBeenCalled();
  });

  it('400s on an invalid invoice id', async () => {
    const res = await POST(req(), ctx('nope'));
    expect(res.status).toBe(400);
  });

  it('404s when the invoice is missing', async () => {
    getInvoiceMock.mockResolvedValueOnce(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
    expect(chargeMock).not.toHaveBeenCalled();
  });

  it('409s (no-balance) when the invoice is already paid', async () => {
    getInvoiceMock.mockResolvedValueOnce({ ...INVOICE, status: 'paid', balance: 0 });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('no-balance');
    expect(chargeMock).not.toHaveBeenCalled();
  });

  it('400s when the invoice is cancelled', async () => {
    getInvoiceMock.mockResolvedValueOnce({ ...INVOICE, status: 'cancelled' });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(400);
    expect(chargeMock).not.toHaveBeenCalled();
  });

  it('409s (no-card) when there is no saved vault token', async () => {
    sbRef.current = makeSb({ ...QUOTE, valor_vault_token: null });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('no-card');
    expect(chargeMock).not.toHaveBeenCalled();
  });

  it('charges the EXACT balance, settles the invoice, and closes the job on success', async () => {
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, charged: true });
    expect(chargeMock).toHaveBeenCalledWith(
      expect.objectContaining({ vaultToken: 'vault-token-abc', amountUsd: 2500, orderRef: `bal_${QID}` }),
    );
    expect(markPaidMock).toHaveBeenCalledWith(ID);
    expect(setJobStatusMock).toHaveBeenCalledWith('job-1', 'done');
  });

  it('402s (partial-capture) and does NOT settle when the card captured less than the balance', async () => {
    chargeMock.mockResolvedValueOnce({ ok: true, chargedUsd: 300, txnId: 'txn-9', approvalCode: 'A1', receiptUrl: 'r', raw: {} });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(402);
    expect(json.reason).toBe('partial-capture');
    expect(markPaidMock).not.toHaveBeenCalled();
  });

  it('402s (partial-capture) and does NOT settle when the seam reports no captured amount', async () => {
    chargeMock.mockResolvedValueOnce({ ok: true, chargedUsd: null, txnId: 'txn-9', approvalCode: 'A1', receiptUrl: 'r', raw: {} });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(402);
    expect(json.reason).toBe('partial-capture');
    expect(markPaidMock).not.toHaveBeenCalled();
  });

  it('402s and does NOT settle when the charge is declined; the pending claim is released via a CAS', async () => {
    chargeMock.mockResolvedValueOnce({ ok: false, reason: 'declined', message: 'Card declined' });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(402);
    expect(json.reason).toBe('declined');
    expect(markPaidMock).not.toHaveBeenCalled();

    // idempotency: claim (call 0), then release-on-decline (call 1) — a CAS
    // against the EXACT sentinel written by the claim, so it can never clobber
    // a concurrent real txn id.
    const calls = invoiceCallsOf(sbRef.current);
    expect(calls).toHaveLength(2);
    const claimSentinel = calls[0].patch.valor_balance_txn_id;
    expect(claimSentinel).toMatch(/^pending:/);
    expect(calls[0].isCalls).toContainEqual(['valor_balance_txn_id', null]);
    expect(calls[1].patch.valor_balance_txn_id).toBeNull();
    expect(calls[1].eqs).toContainEqual(['valor_balance_txn_id', claimSentinel]);
  });

  it('500s (settle-failed) but signals the charge went through when the settle throws', async () => {
    markPaidMock.mockRejectedValueOnce(new Error('db down'));
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(json.reason).toBe('settle-failed');
    expect(json.txnId).toBe('txn-9');
  });
});

describe('POST /api/invoices/[id]/charge-balance — WT-18 re-consent settlement gate', () => {
  it('409s reconsent-required after a price-INCREASING amendment, without charging', async () => {
    sbRef.current = makeSb({ ...QUOTE, approval_snapshot: { amendments: [{ delta: 500, new_total: 6000 }] } });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.ok).toBe(false);
    expect(json.reason).toBe('reconsent-required');
    expect(json.code).toBe('reconsent-required');
    expect(chargeMock).not.toHaveBeenCalled();
  });

  it('still blocks when a cosmetic amendment follows the pending increase', async () => {
    sbRef.current = makeSb({
      ...QUOTE,
      approval_snapshot: {
        amendments: [
          { delta: 500, new_total: 6000, consent: { status: 'pending' } },
          { delta: 0, previous_total: 6000, new_total: 6000 },
        ],
      },
    });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('reconsent-required');
    expect(chargeMock).not.toHaveBeenCalled();
  });

  it('succeeds with an operator override in the body', async () => {
    sbRef.current = makeSb({ ...QUOTE, approval_snapshot: { amendments: [{ delta: 500, new_total: 6000 }] } });
    const res = await POST(req({ overrideReconsent: true }), ctx());
    expect(res.status).toBe(200);
    expect(chargeMock).toHaveBeenCalled();
  });

  it('succeeds with an operator override via the ?override=true query param', async () => {
    sbRef.current = makeSb({ ...QUOTE, approval_snapshot: { amendments: [{ delta: 500, new_total: 6000 }] } });
    const res = await POST(req(undefined, 'override=true'), ctx());
    expect(res.status).toBe(200);
    expect(chargeMock).toHaveBeenCalled();
  });

  it('allows settlement after the customer signed the latest price increase', async () => {
    sbRef.current = makeSb({
      ...QUOTE,
      approval_snapshot: {
        amendments: [{
          delta: 500,
          new_total: 6000,
          consent: {
            status: 'accepted',
            accepted_at: '2026-07-18T12:00:00.000Z',
            signature: {
              name: 'Jordan Smith',
              kind: 'typed',
              value: 'Jordan Smith',
              signed_at: '2026-07-18T12:00:00.000Z',
              ip: null,
            },
          },
        }],
      },
    });
    const res = await POST(req({}), ctx());
    expect(res.status).toBe(200);
    expect(chargeMock).toHaveBeenCalled();
  });

  it('does NOT block a non-increasing (price-DECREASING) amendment', async () => {
    sbRef.current = makeSb({ ...QUOTE, approval_snapshot: { amendments: [{ delta: -500, new_total: 4500 }] } });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(chargeMock).toHaveBeenCalled();
  });

  it('does NOT block a zero-delta (cosmetic) amendment', async () => {
    sbRef.current = makeSb({ ...QUOTE, approval_snapshot: { amendments: [{ delta: 0, new_total: 5000 }] } });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(chargeMock).toHaveBeenCalled();
  });

  it('does NOT block a quote with no amendments at all (default fixture)', async () => {
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(chargeMock).toHaveBeenCalled();
  });
});

describe('POST /api/invoices/[id]/charge-balance — charge idempotency pre-claim', () => {
  it('fresh null valor_balance_txn_id → claims a pending sentinel (CAS on null) then charges', async () => {
    // default fixture already has valor_balance_txn_id: null
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(chargeMock).toHaveBeenCalled();

    const calls = invoiceCallsOf(sbRef.current);
    // call 0 = the claim; call 1 = the post-settle txn-record write.
    expect(calls[0].patch.valor_balance_txn_id).toMatch(/^pending:/);
    expect(calls[0].isCalls).toContainEqual(['valor_balance_txn_id', null]);
  });

  it('loses the claim race (0 rows updated on a null claim) → 409 charge-in-flight, no charge attempted', async () => {
    getInvoiceMock.mockResolvedValueOnce({ ...INVOICE, valor_balance_txn_id: null });
    sbRef.current = makeSb(QUOTE, [{ data: [], error: null }]); // claim update matches 0 rows — lost the race
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('charge-in-flight');
    expect(chargeMock).not.toHaveBeenCalled();
  });

  it('a FRESH pending claim (< 15 min old) held by a concurrent request → 409 charge-in-flight, no charge attempted', async () => {
    const fresh = new Date(Date.now() - 2 * 60 * 1000).toISOString(); // 2 min ago
    getInvoiceMock.mockResolvedValueOnce({ ...INVOICE, valor_balance_txn_id: `pending:${fresh}` });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('charge-in-flight');
    expect(chargeMock).not.toHaveBeenCalled();
    // Short-circuits before ever writing — no invoices-table update attempted.
    expect(invoiceCallsOf(sbRef.current)).toHaveLength(0);
  });

  it('a STALE pending claim (> 15 min old) is reclaimed via a CAS on the exact stale value, then the charge proceeds', async () => {
    const stale = new Date(Date.now() - 20 * 60 * 1000).toISOString(); // 20 min ago
    const staleValue = `pending:${stale}`;
    getInvoiceMock.mockResolvedValueOnce({ ...INVOICE, valor_balance_txn_id: staleValue });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(chargeMock).toHaveBeenCalled();

    const calls = invoiceCallsOf(sbRef.current);
    expect(calls[0].patch.valor_balance_txn_id).toMatch(/^pending:/);
    expect(calls[0].eqs).toContainEqual(['valor_balance_txn_id', staleValue]);
  });

  it('a real Valor txn id already on file → 409 already-charged, no charge attempted, no write', async () => {
    getInvoiceMock.mockResolvedValueOnce({ ...INVOICE, valor_balance_txn_id: 'TXN-REAL-42' });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('already-charged');
    expect(chargeMock).not.toHaveBeenCalled();
    expect(invoiceCallsOf(sbRef.current)).toHaveLength(0);
  });

  it('an AMBIGUOUS timeout LEAVES the pending sentinel (no release call) and the response says to reconcile', async () => {
    chargeMock.mockResolvedValueOnce({
      ok: false,
      reason: 'error',
      message: 'Valor balance charge timed out — check Valor before retrying (do not auto-retry)',
    });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(402);
    expect(json.reason).toBe('error');
    expect(json.error.toLowerCase()).toContain('reconcile');
    expect(markPaidMock).not.toHaveBeenCalled();

    // Only the initial claim wrote to invoices — no release/CAS-clear call.
    const calls = invoiceCallsOf(sbRef.current);
    expect(calls).toHaveLength(1);
    expect(calls[0].patch.valor_balance_txn_id).toMatch(/^pending:/);
  });
});
