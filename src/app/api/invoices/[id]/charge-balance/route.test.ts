// Tests for POST /api/invoices/[id]/charge-balance (#83). Operator-triggered
// card-on-file charge of the invoice balance, gated behind VALOR_AUTO_CHARGE_ENABLED.
// Valor seam, invoices, jobs, supabase, and auth are mocked; planBalanceCollection is real.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { type NextRequest } from 'next/server';

const {
  sbRef,
  requireOperatorMock,
  getInvoiceMock,
  getJobMock,
  setJobStatusMock,
  chargeMock,
  isAutoChargeEnabledMock,
  sendEmailMock,
  appendRetiredTxnMock,
  staleBalanceEmailSubjectMock,
  staleBalanceEmailHtmlMock,
} = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getInvoiceMock: vi.fn(async (): Promise<unknown> => null),
  getJobMock: vi.fn(async (): Promise<unknown> => ({ id: 'job-1', status: 'requires_invoicing' })),
  setJobStatusMock: vi.fn(async (): Promise<unknown> => ({ id: 'job-1', status: 'done' })),
  chargeMock: vi.fn(async (): Promise<unknown> => ({ ok: true, chargedUsd: 2500, txnId: 'txn-9', approvalCode: 'A1', receiptUrl: 'r', raw: {} })),
  isAutoChargeEnabledMock: vi.fn(() => true),
  sendEmailMock: vi.fn(async (): Promise<unknown> => undefined),
  appendRetiredTxnMock: vi.fn(async (): Promise<boolean> => true),
  // #173 money-review: real spies (not plain arrow fns) so tests can assert
  // the sign-aware `direction` argument reaches the email builders.
  staleBalanceEmailSubjectMock: vi.fn((..._args: unknown[]) => 'stale-balance-subject'),
  staleBalanceEmailHtmlMock: vi.fn((..._args: unknown[]) => '<p>stale-balance</p>'),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/invoices', () => ({ getInvoice: getInvoiceMock, appendRetiredTxn: appendRetiredTxnMock }));
vi.mock('@/lib/jobs', () => ({ getJob: getJobMock, setJobStatus: setJobStatusMock }));
vi.mock('@/lib/integrations/valorBalance', () => ({
  chargeBalanceOnFile: chargeMock,
  isAutoChargeEnabled: isAutoChargeEnabledMock,
  CHARGE_SLOT_STALE_MS: 15 * 60 * 1000,
}));
vi.mock('@/lib/integrations/highlevel', () => ({
  sendEmail: sendEmailMock,
  isHighLevelConfigured: () => true,
}));
vi.mock('@/lib/integrations/quoteMessages', () => ({
  duplicatePaymentEmailSubject: () => 'dup',
  duplicatePaymentEmailHtml: () => '<p>dup</p>',
  staleBalanceEmailSubject: staleBalanceEmailSubjectMock,
  staleBalanceEmailHtml: staleBalanceEmailHtmlMock,
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
  ins: [string, unknown][];
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
    const call: InvoiceUpdateCall = { patch, eqs: [], isCalls: [], ins: [] };
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
      in: (col: string, val: unknown) => {
        call.ins.push([col, val]);
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
  process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1'; // the #170(a) double-charge alert recipient
  process.env.PORTAL_BASE_URL = 'https://portal.test'; // the mock req has no nextUrl.origin
  getInvoiceMock.mockResolvedValue({ ...INVOICE });
  getJobMock.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
  setJobStatusMock.mockResolvedValue({ id: 'job-1', status: 'done' });
  chargeMock.mockResolvedValue({ ok: true, chargedUsd: 2500, txnId: 'txn-9', approvalCode: 'A1', receiptUrl: 'r', raw: {} });
  sbRef.current = makeSb(QUOTE);
});

// The settle write (#170a) selects the settled row — hand it a job_id so the
// job-close leg runs. Index 1 in the response queue = the settle call
// (0 = claim, 1 = settle, 2 = txn record).
const SETTLE_OK = [
  { data: [{ id: ID }], error: null },
  { data: [{ id: ID, job_id: 'job-1' }], error: null },
];

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

  it('charges the EXACT balance, settles via an atomic status claim, and closes the job on success', async () => {
    sbRef.current = makeSb(QUOTE, SETTLE_OK);
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, charged: true });
    expect(chargeMock).toHaveBeenCalledWith(
      expect.objectContaining({ vaultToken: 'vault-token-abc', amountUsd: 2500, orderRef: `bal_${QID}` }),
    );
    // #170(a): calls = claim, settle (atomic on a settle-able status), txn record (CAS on the sentinel).
    const calls = invoiceCallsOf(sbRef.current);
    expect(calls).toHaveLength(3);
    expect(calls[1].patch).toMatchObject({ status: 'paid', balance: 0 });
    expect(calls[1].ins).toContainEqual(['status', ['draft', 'awaiting_payment']]);
    const claimSentinel = calls[0].patch.valor_balance_txn_id;
    expect(calls[2].patch.valor_balance_txn_id).toBe('txn-9');
    expect(calls[2].eqs).toContainEqual(['valor_balance_txn_id', claimSentinel]);
    expect(setJobStatusMock).toHaveBeenCalledWith('job-1', 'done');
  });

  it('402s (amount-mismatch) and does NOT settle when the card captured less than the balance', async () => {
    chargeMock.mockResolvedValueOnce({ ok: true, chargedUsd: 300, txnId: 'txn-9', approvalCode: 'A1', receiptUrl: 'r', raw: {} });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(402);
    expect(json.reason).toBe('amount-mismatch');
    // Claim only — no settle write ever ran.
    expect(invoiceCallsOf(sbRef.current)).toHaveLength(1);
  });

  it('402s (amount-mismatch) and does NOT settle when the seam reports no captured amount', async () => {
    chargeMock.mockResolvedValueOnce({ ok: true, chargedUsd: null, txnId: 'txn-9', approvalCode: 'A1', receiptUrl: 'r', raw: {} });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(402);
    expect(json.reason).toBe('amount-mismatch');
    expect(invoiceCallsOf(sbRef.current)).toHaveLength(1);
  });

  it('402s (amount-mismatch) when the capture is 100× the balance (#165 cents-parse class) — never settles', async () => {
    chargeMock.mockResolvedValueOnce({ ok: true, chargedUsd: 250000, txnId: 'txn-9', approvalCode: 'A1', receiptUrl: 'r', raw: {} });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(402);
    expect(json.reason).toBe('amount-mismatch');
    expect(invoiceCallsOf(sbRef.current)).toHaveLength(1);
  });

  it('402s and does NOT settle when the charge is declined; the pending claim is released via a CAS', async () => {
    chargeMock.mockResolvedValueOnce({ ok: false, reason: 'declined', message: 'Card declined' });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(402);
    expect(json.reason).toBe('declined');

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

  it('500s (settle-failed) but signals the charge went through when the settle write errors', async () => {
    sbRef.current = makeSb(QUOTE, [
      { data: [{ id: ID }], error: null }, // claim ok
      { data: null, error: { message: 'db down' } }, // settle write fails
    ]);
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(500);
    expect(json.reason).toBe('settle-failed');
    expect(json.txnId).toBe('txn-9');
  });

  // ─── #170(a): the cross-path double-charge race ───────────────────────────
  it('409s (double-charge) when the pay-link webhook settled DURING our charge: keeps their txn, logs ours, alerts', async () => {
    // The 0-rows re-read sees the webhook's settled state (paid + their txn).
    getInvoiceMock
      .mockResolvedValueOnce({ ...INVOICE }) // route-top read
      .mockResolvedValueOnce({ ...INVOICE }) // #173 post-claim fresh-read — nothing moved yet, charge proceeds at 2500
      .mockResolvedValueOnce({ ...INVOICE, status: 'paid', valor_balance_txn_id: 'TXN-WEBHOOK-1' }); // 0-row diagnosis re-read
    sbRef.current = makeSb(QUOTE, [
      { data: [{ id: ID }], error: null }, // claim ok
      { data: [], error: null }, // settle claims 0 rows — the webhook settled first
    ]);
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('double-charge');
    expect(json.txnId).toBe('txn-9');
    expect(json.error).toContain('VOID');

    const calls = invoiceCallsOf(sbRef.current);
    // claim + settle(0 rows) only — the stash goes through the CAS'd
    // appendRetiredTxn, and NO write anywhere puts OUR txn id into
    // valor_balance_txn_id (the webhook's record wins).
    expect(calls).toHaveLength(2);
    for (const c of calls.slice(1)) {
      expect(c.patch.valor_balance_txn_id).toBeUndefined();
    }
    expect(appendRetiredTxnMock).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ txnId: 'txn-9', reason: expect.stringContaining('VOID') }),
    );
    // The alert email carries BOTH txn ids (#640 review MED: existingTxnId was
    // hardcoded null — staff need the webhook's id to reconcile in Valor).
    expect(sendEmailMock).toHaveBeenCalled();
    expect(setJobStatusMock).not.toHaveBeenCalled();
  });

  it("409s (charged-cancelled) when the invoice was CANCELLED during the charge — refund guidance, not 'double charge'", async () => {
    // #640 review HIGH: a job-cancel racing the in-flight charge also claims
    // 0 rows on settle — but no duplicate payment exists; a single real charge
    // landed on a cancelled invoice and needs a REFUND.
    getInvoiceMock
      .mockResolvedValueOnce({ ...INVOICE }) // route-top read
      .mockResolvedValueOnce({ ...INVOICE }) // #173 post-claim fresh-read — nothing moved yet, charge proceeds at 2500
      .mockResolvedValueOnce({ ...INVOICE, status: 'cancelled' }); // 0-row diagnosis re-read
    sbRef.current = makeSb(QUOTE, [
      { data: [{ id: ID }], error: null }, // claim ok
      { data: [], error: null }, // settle claims 0 rows — cancelled, not paid
    ]);
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('charged-cancelled');
    expect(json.error).toContain('REFUND');
    expect(json.error).not.toContain('TWICE');
    expect(appendRetiredTxnMock).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ txnId: 'txn-9', reason: expect.stringContaining('REFUND') }),
    );
    expect(setJobStatusMock).not.toHaveBeenCalled();
  });

  // ─── #170(c): absolute ceiling ────────────────────────────────────────────
  it('409s (over-cap) without charging when the balance exceeds the auto-charge ceiling', async () => {
    getInvoiceMock.mockResolvedValueOnce({ ...INVOICE, balance: 30_000 });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('over-cap');
    expect(chargeMock).not.toHaveBeenCalled();
    expect(invoiceCallsOf(sbRef.current)).toHaveLength(0);
  });

  // ─── #170(d): cash/check payment preference ───────────────────────────────
  it('409s (cash-preference) without charging when the customer is marked cash/check', async () => {
    getInvoiceMock.mockResolvedValueOnce({ ...INVOICE, payment_preference: 'cash_check' });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('cash-preference');
    expect(chargeMock).not.toHaveBeenCalled();
    expect(invoiceCallsOf(sbRef.current)).toHaveLength(0);
  });

  it('charges a cash/check customer only with the explicit overridePreference', async () => {
    getInvoiceMock.mockResolvedValueOnce({ ...INVOICE, payment_preference: 'cash_check' });
    sbRef.current = makeSb(QUOTE, SETTLE_OK);
    const res = await POST(req({ overridePreference: true }), ctx());
    expect(res.status).toBe(200);
    expect(chargeMock).toHaveBeenCalled();
  });
});

// ─── #199: NCE trade-settled balance ────────────────────────────────────────
describe('POST /api/invoices/[id]/charge-balance — NCE trade-settled balance (#199)', () => {
  it('409s (nce-blocked) without charging when the quote is NCE-tagged', async () => {
    sbRef.current = makeSb({ ...QUOTE, is_nce: true });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('nce-blocked');
    expect(chargeMock).not.toHaveBeenCalled();
    expect(invoiceCallsOf(sbRef.current)).toHaveLength(0);
  });

  it('charges an NCE quote only with the explicit overrideNce', async () => {
    sbRef.current = makeSb({ ...QUOTE, is_nce: true }, SETTLE_OK);
    const res = await POST(req({ overrideNce: true }), ctx());
    expect(res.status).toBe(200);
    expect(chargeMock).toHaveBeenCalled();
  });

  it('fires the NCE block BEFORE the cash-preference check when both apply', async () => {
    getInvoiceMock.mockResolvedValueOnce({ ...INVOICE, payment_preference: 'cash_check' });
    sbRef.current = makeSb({ ...QUOTE, is_nce: true });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('nce-blocked'); // not 'cash-preference'
    expect(chargeMock).not.toHaveBeenCalled();
  });

  it('an NCE + cash/check invoice needs BOTH overrides to actually charge', async () => {
    // overrideNce alone clears NCE but still hits the cash-preference gate.
    getInvoiceMock.mockResolvedValueOnce({ ...INVOICE, payment_preference: 'cash_check' });
    sbRef.current = makeSb({ ...QUOTE, is_nce: true });
    const res1 = await POST(req({ overrideNce: true }), ctx());
    const json1 = await res1.json();
    expect(res1.status).toBe(409);
    expect(json1.reason).toBe('cash-preference');
    expect(chargeMock).not.toHaveBeenCalled();

    // Both overrides together clear both gates.
    getInvoiceMock.mockResolvedValueOnce({ ...INVOICE, payment_preference: 'cash_check' });
    sbRef.current = makeSb({ ...QUOTE, is_nce: true }, SETTLE_OK);
    const res2 = await POST(req({ overrideNce: true, overridePreference: true }), ctx());
    expect(res2.status).toBe(200);
    expect(chargeMock).toHaveBeenCalled();
  });

  it('does not block a non-NCE quote', async () => {
    sbRef.current = makeSb({ ...QUOTE, is_nce: false }, SETTLE_OK);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(chargeMock).toHaveBeenCalled();
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

    // Only the initial claim wrote to invoices — no release/CAS-clear call.
    const calls = invoiceCallsOf(sbRef.current);
    expect(calls).toHaveLength(1);
    expect(calls[0].patch.valor_balance_txn_id).toMatch(/^pending:/);
  });
});

// ─── #173: the stale-balance under-charge race ─────────────────────────────
// invoice.balance is read ONCE at request start; an amend can re-sync it
// UPWARD while this request is in flight. The fix: re-read once more right
// after the idempotency claim lands, charge THAT fresh balance, and pin the
// post-charge settle to the amount actually charged so a balance change
// arriving during the Valor round-trip can't silently settle either.
describe('POST /api/invoices/[id]/charge-balance — #173 stale-balance race', () => {
  it('an amend-before-click bumps the balance UP before the claim: the fresh re-read charges the HIGHER amount, not the stale one', async () => {
    // Route-top read sees the OLD (stale) balance; the post-claim fresh-read
    // sees the amended (higher) one. Nothing else races after that, so the
    // charge should settle cleanly — just at the FRESH amount.
    getInvoiceMock
      .mockResolvedValueOnce({ ...INVOICE, balance: 2500 }) // route-top read (stale)
      .mockResolvedValueOnce({ ...INVOICE, balance: 3000 }); // post-claim fresh-read (amended up)
    chargeMock.mockResolvedValueOnce({ ok: true, chargedUsd: 3000, txnId: 'txn-9', approvalCode: 'A1', receiptUrl: 'r', raw: {} });
    sbRef.current = makeSb(QUOTE, SETTLE_OK);

    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, charged: true });
    expect(chargeMock).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: 3000 }));

    // The settle CAS pins the FRESH amount too.
    const calls = invoiceCallsOf(sbRef.current);
    expect(calls[1].patch).toMatchObject({ status: 'paid', balance: 0 });
    expect(calls[1].eqs).toContainEqual(['balance', 3000]);
  });

  it('the fresh re-read finds the balance already cleared (paid) → releases the claim (CAS-exact) and 409s no-balance, never calling Valor', async () => {
    getInvoiceMock
      .mockResolvedValueOnce({ ...INVOICE, balance: 2500 }) // route-top read
      .mockResolvedValueOnce({ ...INVOICE, status: 'paid', balance: 0 }); // post-claim fresh-read — already settled
    sbRef.current = makeSb(QUOTE, [{ data: [{ id: ID }], error: null }]); // claim ok; release call uses the default queued response

    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('no-balance');
    expect(chargeMock).not.toHaveBeenCalled();

    // claim (call 0) then a CAS-exact release (call 1) — never a settle/charge write.
    const calls = invoiceCallsOf(sbRef.current);
    expect(calls).toHaveLength(2);
    const claimSentinel = calls[0].patch.valor_balance_txn_id;
    expect(calls[1].patch.valor_balance_txn_id).toBeNull();
    expect(calls[1].eqs).toContainEqual(['valor_balance_txn_id', claimSentinel]);
  });

  it('the fresh re-read finds the balance now over the #170(c) ceiling → releases the claim and 409s over-cap, never calling Valor', async () => {
    getInvoiceMock
      .mockResolvedValueOnce({ ...INVOICE, balance: 2500 }) // route-top read (under the ceiling)
      .mockResolvedValueOnce({ ...INVOICE, balance: 30_000 }); // post-claim fresh-read — amended to an absurd balance
    sbRef.current = makeSb(QUOTE, [{ data: [{ id: ID }], error: null }]); // claim ok

    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('over-cap');
    expect(chargeMock).not.toHaveBeenCalled();

    const calls = invoiceCallsOf(sbRef.current);
    expect(calls).toHaveLength(2); // claim + release
    expect(calls[1].patch.valor_balance_txn_id).toBeNull();
  });

  it('a mid-charge amend UP (balance moves DURING the Valor round-trip) claims 0 rows on settle → stale-balance/under: NOT settled, txn recorded as the REAL id (not left pending)', async () => {
    // Fresh-read sees nothing changed yet (charge proceeds at 2500); the
    // amend lands while chargeBalanceOnFile is in flight, so the 0-row
    // diagnosis re-read sees the NEW (higher) balance with status still
    // awaiting_payment.
    getInvoiceMock
      .mockResolvedValueOnce({ ...INVOICE, balance: 2500 }) // route-top read
      .mockResolvedValueOnce({ ...INVOICE, balance: 2500 }) // post-claim fresh-read — unchanged, charge proceeds at 2500
      .mockResolvedValueOnce({ ...INVOICE, status: 'awaiting_payment', balance: 3000 }); // 0-row diagnosis re-read
    sbRef.current = makeSb(QUOTE, [
      { data: [{ id: ID }], error: null }, // claim ok
      { data: [], error: null }, // settle claims 0 rows — balance predicate missed
      { data: [{ id: ID }], error: null }, // #173 HIGH-2: real-txn CAS record
    ]);

    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('stale-balance');
    expect(json.txnId).toBe('txn-9');
    expect(json.error).toContain('NOT settled');
    expect(json.error).toContain('2500');
    expect(json.error).toContain('3000');
    expect(json.error).toContain('owed'); // under-collection copy, not the refund copy
    expect(json.error).not.toContain('REFUND');

    // claim, settle(0 rows), then the #173 HIGH-2 real-txn CAS record — the
    // sentinel is REPLACED (not left pending forever), so a later click 409s
    // already-charged instead of blindly recharging (see the dedicated retry test).
    const calls = invoiceCallsOf(sbRef.current);
    expect(calls).toHaveLength(3);
    const claimSentinel = calls[0].patch.valor_balance_txn_id;
    expect(claimSentinel).toMatch(/^pending:/);
    expect(calls[1].patch.valor_balance_txn_id).toBeUndefined(); // the settle patch never touches it
    expect(calls[2].patch).toMatchObject({ valor_balance_txn_id: 'txn-9', valor_receipt_url: 'r' });
    expect(calls[2].eqs).toContainEqual(['valor_balance_txn_id', claimSentinel]);

    // The real txn id is ALSO preserved via the same CAS'd retirement-log
    // idiom the double-charge/cancelled branches use (the annotated audit
    // trail) — never silently dropped.
    expect(appendRetiredTxnMock).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ txnId: 'txn-9', reason: expect.stringContaining('stale-balance-under-collection') }),
    );
    expect(staleBalanceEmailSubjectMock).toHaveBeenCalledWith('Alice', 'under');
    expect(staleBalanceEmailHtmlMock).toHaveBeenCalledWith(expect.objectContaining({ direction: 'under' }));
    expect(sendEmailMock).toHaveBeenCalled();
    expect(setJobStatusMock).not.toHaveBeenCalled();
  });

  it('a mid-charge amend DOWN claims 0 rows on settle → stale-balance/over: REFUND copy everywhere, never "still owed $0"', async () => {
    // #173 HIGH-1 (money-review): the balance can move DOWN too — chargeAmount
    // ($2500) ends up HIGHER than the true balance ($1900) by the time the
    // diagnosis re-read runs. A naive max(0, diff) would print "$0 still
    // owed"; the fix must say REFUND $600 instead.
    getInvoiceMock
      .mockResolvedValueOnce({ ...INVOICE, balance: 2500 }) // route-top read
      .mockResolvedValueOnce({ ...INVOICE, balance: 2500 }) // post-claim fresh-read — unchanged, charge proceeds at 2500
      .mockResolvedValueOnce({ ...INVOICE, status: 'awaiting_payment', balance: 1900 }); // 0-row diagnosis re-read — amended DOWN
    sbRef.current = makeSb(QUOTE, [
      { data: [{ id: ID }], error: null }, // claim ok
      { data: [], error: null }, // settle claims 0 rows
      { data: [{ id: ID }], error: null }, // real-txn CAS record
    ]);

    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('stale-balance');
    expect(json.error).toContain('OVER-collection');
    expect(json.error).toContain('REFUND');
    expect(json.error).toContain('600'); // the excess: 2500 - 1900
    expect(json.error).not.toContain('still owed');

    expect(appendRetiredTxnMock).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ txnId: 'txn-9', reason: expect.stringContaining('stale-balance-over-collection') }),
    );
    expect(appendRetiredTxnMock).toHaveBeenCalledWith(
      ID,
      expect.objectContaining({ reason: expect.stringContaining('REFUND') }),
    );
    expect(staleBalanceEmailSubjectMock).toHaveBeenCalledWith('Alice', 'over');
    expect(staleBalanceEmailHtmlMock).toHaveBeenCalledWith(expect.objectContaining({ direction: 'over' }));

    // The real txn id still gets recorded (not left pending) even on the
    // over-collection branch.
    const calls = invoiceCallsOf(sbRef.current);
    expect(calls[2].patch).toMatchObject({ valor_balance_txn_id: 'txn-9' });
  });

  it('the balance lands back on the charged amount by the diagnosis re-read → stale-balance/even: honest generic reconcile copy, no owed/refund claim', async () => {
    // Two moves within the same request: whatever made the settle CAS miss
    // (balance != chargeAmount at settle time) reverted by the time the
    // diagnosis re-read ran, landing exactly back on chargeAmount. No net
    // difference — but the CAS still couldn't settle it automatically, so
    // this must NOT claim "still owed" or "refund" (both would be false).
    getInvoiceMock
      .mockResolvedValueOnce({ ...INVOICE, balance: 2500 })
      .mockResolvedValueOnce({ ...INVOICE, balance: 2500 })
      .mockResolvedValueOnce({ ...INVOICE, status: 'awaiting_payment', balance: 2500 });
    sbRef.current = makeSb(QUOTE, [
      { data: [{ id: ID }], error: null },
      { data: [], error: null },
      { data: [{ id: ID }], error: null },
    ]);

    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('stale-balance');
    expect(json.error).not.toContain('still owed');
    expect(json.error).not.toContain('REFUND');
    expect(json.error).toContain('reconcile');
    expect(staleBalanceEmailSubjectMock).toHaveBeenCalledWith('Alice', 'even');
  });

  it('a retry 16+ minutes after a stale-balance under-collection hits already-charged, NOT a second blind auto-charge', async () => {
    // #173 HIGH-2 (money-review): before the fix, the pending sentinel was
    // left in place after a stale-balance diagnosis — 16 minutes later a
    // retry would reclaim the (now-stale) sentinel and charge the FULL new
    // balance again, double-collecting on top of the first real charge. The
    // fix records the REAL txn id instead, so the retry's claim step sees a
    // real (non-pending) id and 409s already-charged before ever calling Valor.
    getInvoiceMock.mockResolvedValueOnce({ ...INVOICE, balance: 3000, valor_balance_txn_id: 'txn-9' });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.reason).toBe('already-charged');
    expect(chargeMock).not.toHaveBeenCalled();
    expect(invoiceCallsOf(sbRef.current)).toHaveLength(0);
  });
});
