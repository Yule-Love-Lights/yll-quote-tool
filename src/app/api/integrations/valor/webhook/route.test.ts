// Sandbox integration test for the Valor payment webhook (#38). Proves the
// booked → receipt → CRM-move orchestration end-to-end WITHOUT a real Valor
// account or database: a correctly-signed fake webhook is POSTed at the handler
// with Supabase + HighLevel mocked. Also locks in the atomic idempotency guard
// (concurrent retries must not double-fire side effects) and the liveness-probe
// branch that lets Valor's "Verify and Update" button pass.
//
// This is the "prove the flow today" harness — it does NOT replace the live
// staging test (which confirms Valor's real field names against the CONFIRM:
// seams), but it gives us confidence the server-side logic is correct now.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import type { NextRequest } from 'next/server';

// ── Mocks (hoisted so the vi.mock factories can see them) ───────────────────
const {
  sbRef,
  hl,
  createJobFromQuote,
  getJobByQuote,
  setJobStatus,
  getInvoiceByJob,
  notifyTelegram,
  getJobWorkOrder,
} = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  hl: {
    sendSms: vi.fn(async () => ({})),
    sendEmail: vi.fn(async () => ({})),
    updateOpportunityStage: vi.fn(async () => ({})),
    configured: { value: true },
  },
  // #83 balance pay-link branch helpers.
  getJobByQuote: vi.fn(async (): Promise<unknown> => null),
  setJobStatus: vi.fn(async (): Promise<unknown> => ({})),
  getInvoiceByJob: vi.fn(async (): Promise<unknown> => null),
  // The job auto-create (#83 Phase 2). Mocked so the webhook test asserts the
  // wiring (called once on booking, never on replay) without touching the
  // jobs table. Its OWN idempotency is covered in src/lib/jobs.test.ts.
  createJobFromQuote: vi.fn(async () => ({ id: 'job-1' })),
  // Proactive prep ping (#82 follow-up): the work order feeds the message; the
  // notifier is mocked so we assert it fires once per booking, never on replay.
  notifyTelegram: vi.fn<(text: string) => Promise<void>>(),
  getJobWorkOrder: vi.fn(async () => ({
    job: {
      id: 'job-1', jobNumber: 1042, quoteId: 'quote-1', designId: null,
      stage: 'awaiting_materials', status: 'to_schedule', installDate: null,
      customerName: 'Jordan Smith', customerAddress: null, stockDecrementedAt: null,
    },
    materials: {
      materials: [{ sku: '1001', name: 'C9 Warm White', qty: 120, onHand: 200, short: false }],
      unbound: [], totalLines: 1,
    },
  })),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

vi.mock('@/lib/jobs', () => ({
  createJobFromQuote,
  getJobByQuote,
  setJobStatus,
}));

vi.mock('@/lib/invoices', () => ({
  getInvoiceByJob,
}));

vi.mock('@/lib/integrations/telegramNotify', () => ({
  notifyTelegram,
}));

vi.mock('@/lib/inventory/jobs', () => ({
  getJobWorkOrder,
}));

vi.mock('@/lib/integrations/highlevel', () => ({
  sendSms: hl.sendSms,
  sendEmail: hl.sendEmail,
  updateOpportunityStage: hl.updateOpportunityStage,
  isHighLevelConfigured: () => hl.configured.value,
  HighLevelError: class HighLevelError extends Error {},
}));

import { POST, GET } from './route';

// ── Fake Supabase query builder ─────────────────────────────────────────────
// Handles the two chains the route uses:
//   read:  from().select().eq().single()              -> { data: quote }
//   write: from().update().eq().eq().is().select('id') -> { data: claimRows }
// The builder is thenable; only the write path awaits it directly, so `then`
// resolves the claim result while `single()` resolves the read.
type Quote = Record<string, unknown> | null;
function makeSb(quote: Quote, claimRows: Array<{ id: string }>) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  const builder: Record<string, unknown> = {};
  let isUpdate = false;
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    update: (payload: Record<string, unknown>) => {
      isUpdate = true;
      updatePayloads.push(payload);
      return builder;
    },
    eq: () => builder,
    neq: () => builder,
    is: () => builder,
    single: async () => ({ data: quote, error: quote ? null : { message: 'no row' } }),
    maybeSingle: async () => ({ data: quote, error: null }),
    then: (resolve: (v: unknown) => void) => {
      const res = isUpdate ? { data: claimRows, error: null } : { data: quote, error: null };
      isUpdate = false;
      resolve(res);
    },
  });
  return { client: builder, updatePayloads };
}

const SECRET = 'test-webhook-secret';

function makeReq(rawBody: string, headers: Record<string, string>): NextRequest {
  return {
    text: async () => rawBody,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    nextUrl: { origin: 'https://quote.example.com' },
  } as unknown as NextRequest;
}

// Build a correctly-signed webhook request. `base` controls which signing
// convention to use, so we can prove BOTH Valor's documented `${body}${ts}`
// base and the Stripe-style `${ts}.${body}` fallback verify.
function signedReq(
  payload: Record<string, unknown>,
  opts: { secret?: string; base?: 'valor' | 'stripe' } = {},
) {
  const rawBody = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const signed = opts.base === 'stripe' ? `${ts}.${rawBody}` : `${rawBody}${ts}`;
  const sig = createHmac('sha256', opts.secret ?? SECRET).update(signed).digest('hex');
  return makeReq(rawBody, { 'valor-signature': sig, 'valor-timestamp': ts });
}

const APPROVED_PAYLOAD = {
  txn_id: 'TXN-123',
  response_code: '00',
  amount: '1350.00',
  approval_code: 'AUTH99',
  receipt_url: 'https://valor/receipt/123',
  vault_token: 'vault_abc',
  order_id: 'qdeadbeef',
};

const QUOTE = {
  id: 'quote-1',
  customer_name: 'Jordan Smith',
  customer_phone: '+15551234567',
  customer_email: 'jordan@example.com',
  total: 2700,
  result: { total: 2700, depositAmount: 1350 },
  highlevel_contact_id: 'contact-1',
  highlevel_opportunity_id: 'opp-1',
  deposit_paid_at: null,
  deposit_amount_usd: 1350,
  approval_snapshot: { customerSelection: { currentTotalUsd: 2700, currentDepositUsd: 1350 } },
};

beforeEach(() => {
  vi.clearAllMocks();
  hl.configured.value = true;
  process.env.VALOR_WEBHOOK_SECRET = SECRET;
  process.env.HIGHLEVEL_STAGE_QUOTE_APPROVED = 'stage-approved';
  process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
  process.env.PORTAL_BASE_URL = 'https://quote.example.com';
});

describe('Valor webhook — happy path', () => {
  it('books the quote, stamps payment, and fires receipt + CRM move', async () => {
    const { client, updatePayloads } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);

    // payment stamped with the Valor fields
    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0]).toMatchObject({
      valor_txn_id: 'TXN-123',
      valor_vault_token: 'vault_abc',
      valor_approval_code: 'AUTH99',
      valor_receipt_url: 'https://valor/receipt/123',
    });
    expect(updatePayloads[0].deposit_paid_at).toBeTruthy();

    // CRM move + customer receipt (sms + email) + internal "paid" email
    expect(hl.updateOpportunityStage).toHaveBeenCalledWith('opp-1', 'stage-approved');
    expect(hl.sendSms).toHaveBeenCalledTimes(1);
    expect(hl.sendEmail).toHaveBeenCalledTimes(2); // customer receipt + internal alert

    // #83 Phase 2: booking auto-creates exactly one Job from the quote.
    expect(createJobFromQuote).toHaveBeenCalledTimes(1);
    expect(createJobFromQuote).toHaveBeenCalledWith('quote-1');

    // #82 follow-up: a proactive prep ping fires once, listing the job's materials.
    expect(getJobWorkOrder).toHaveBeenCalledWith('job-1');
    expect(notifyTelegram).toHaveBeenCalledTimes(1);
    expect(notifyTelegram.mock.calls[0][0]).toContain('New job to prep');
    expect(notifyTelegram.mock.calls[0][0]).toContain('Jordan Smith');
    expect(notifyTelegram.mock.calls[0][0]).toContain('C9 Warm White');
  });

  it('still books even if the job auto-create throws (best-effort)', async () => {
    const { client } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;
    createJobFromQuote.mockRejectedValueOnce(new Error('jobs table missing'));

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true); // payment recorded despite the job failure
  });

  it('verifies a signature built with the Stripe-style `${ts}.${body}` fallback base', async () => {
    const { client } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD, { base: 'stripe' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
  });
});

describe('Valor webhook — verification probe (Verify and Update)', () => {
  it('GET returns 200 for a reachability check', async () => {
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it('acks an empty/no-transaction POST 200 without touching anything', async () => {
    // No secret, no signature, no DB — a probe must still pass.
    delete process.env.VALOR_WEBHOOK_SECRET;
    sbRef.current = null;

    const res = await POST(makeReq('{}', {}));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.verification).toBe(true);
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.updateOpportunityStage).not.toHaveBeenCalled();
  });
});

describe('Valor webhook — idempotency (the fix)', () => {
  it('does NOT double-fire side effects when the atomic claim loses the race', async () => {
    // Conditional update returns 0 rows → a concurrent retry already claimed it.
    const { client } = makeSb({ ...QUOTE }, []);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.alreadyPaid).toBe(true);
    expect(hl.updateOpportunityStage).not.toHaveBeenCalled();
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.sendEmail).not.toHaveBeenCalled();
    // Lost the race → the winning request creates the job; this replay must not.
    expect(createJobFromQuote).not.toHaveBeenCalled();
    expect(notifyTelegram).not.toHaveBeenCalled(); // and no prep ping on replay
  });

  it('short-circuits when the quote is already marked paid', async () => {
    const { client } = makeSb({ ...QUOTE, deposit_paid_at: '2026-06-25T00:00:00Z' }, []);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    const json = await res.json();

    expect(json.alreadyPaid).toBe(true);
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(createJobFromQuote).not.toHaveBeenCalled(); // no second job on replay
    expect(notifyTelegram).not.toHaveBeenCalled(); // and no prep ping
  });
});

describe('Valor webhook — rejects', () => {
  it('401s on an invalid signature', async () => {
    const { client } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;
    const req = signedReq(APPROVED_PAYLOAD, { secret: 'wrong-secret' });

    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(hl.sendSms).not.toHaveBeenCalled();
  });

  it('503s when VALOR_WEBHOOK_SECRET is not configured (for a real txn)', async () => {
    delete process.env.VALOR_WEBHOOK_SECRET;
    const { client } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    expect(res.status).toBe(503);
  });

  it('acks 200 and ignores a validly-signed txn that maps to no quote (unrelated sale)', async () => {
    // A normal terminal sale on the same EPI: signature is valid, but there's no
    // quote with this order ref. We must NOT 404 (Valor would retry every such
    // sale) — ack + ignore, no side effects.
    const { client, updatePayloads } = makeSb(null, []);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ignored).toBe('no-matching-quote');
    expect(updatePayloads).toHaveLength(0);
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.updateOpportunityStage).not.toHaveBeenCalled();
  });

  it('acknowledges a declined transaction without booking it', async () => {
    const { client, updatePayloads } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq({ ...APPROVED_PAYLOAD, response_code: '05' }));
    const json = await res.json();

    expect(json.booked).toBe(false);
    expect(json.declined).toBe(true);
    expect(updatePayloads).toHaveLength(0); // never stamped paid
    expect(hl.sendSms).not.toHaveBeenCalled();
  });

  it('ignores a webhook for a TEST quote (#93) — no booking, no real side effects', async () => {
    // A test quote can't normally reach here (it has no valor_order_ref), but the
    // defensive guard must short-circuit before any charge/CRM/job side effect.
    const { client, updatePayloads } = makeSb({ ...QUOTE, is_test: true }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ignored).toBe('test-quote');
    expect(updatePayloads).toHaveLength(0); // never stamped paid
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.updateOpportunityStage).not.toHaveBeenCalled();
    expect(createJobFromQuote).not.toHaveBeenCalled();
  });
});

describe('Valor webhook — balance pay-link (#83)', () => {
  const BAL_ID = '8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60';
  const BAL_PAYLOAD = { ...APPROVED_PAYLOAD, order_id: `bal_${BAL_ID}` };

  it('marks the invoice paid + closes the job on an approved balance payment (NOT the deposit path)', async () => {
    const { client, updatePayloads } = makeSb({ id: 'quote-1', is_test: false }, [{ id: 'inv-1' }]);
    sbRef.current = client;
    getJobByQuote.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
    getInvoiceByJob.mockResolvedValue({ id: 'inv-1', status: 'awaiting_payment', balance: 1350 });

    const res = await POST(signedReq(BAL_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ balance: true, paid: true });
    expect(updatePayloads[0]).toMatchObject({ status: 'paid', balance: 0 });
    expect(setJobStatus).toHaveBeenCalledWith('job-1', 'done');
    expect(createJobFromQuote).not.toHaveBeenCalled(); // never the booking path
  });

  it('does NOT settle on an underpayment (paid amount < balance)', async () => {
    const { client, updatePayloads } = makeSb({ id: 'quote-1', is_test: false }, [{ id: 'inv-1' }]);
    sbRef.current = client;
    getJobByQuote.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
    getInvoiceByJob.mockResolvedValue({ id: 'inv-1', status: 'awaiting_payment', balance: 1350 });

    const res = await POST(signedReq({ ...BAL_PAYLOAD, amount: '1.00' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.underpaid).toBe(true);
    expect(updatePayloads).toHaveLength(0); // never settled
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  it('ignores a balance webhook for a TEST quote (no real settle)', async () => {
    const { client, updatePayloads } = makeSb({ id: 'quote-1', is_test: true }, []);
    sbRef.current = client;
    getJobByQuote.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
    getInvoiceByJob.mockResolvedValue({ id: 'inv-1', status: 'awaiting_payment', balance: 1350 });

    const res = await POST(signedReq(BAL_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ignored).toBe('test-quote');
    expect(updatePayloads).toHaveLength(0);
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  it('is idempotent — a replay on an already-paid invoice does not re-close the job', async () => {
    const { client, updatePayloads } = makeSb({ id: 'quote-1', is_test: false }, []);
    sbRef.current = client;
    getJobByQuote.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
    getInvoiceByJob.mockResolvedValue({ id: 'inv-1', status: 'paid', balance: 0 });

    const res = await POST(signedReq(BAL_PAYLOAD));
    const json = await res.json();

    expect(json.alreadyPaid).toBe(true);
    expect(updatePayloads).toHaveLength(0);
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  // B6 fix: a late or retried balance webhook must NOT resurrect a CANCELLED invoice.
  // Valor retries up to 3×; the cancellation may arrive between the pay-link send
  // and the webhook. The invoice must stay cancelled and the job must not be closed.
  it('does NOT settle a CANCELLED invoice — 200 ack, no status change, job left alone', async () => {
    const { client, updatePayloads } = makeSb({ id: 'quote-1', is_test: false }, []);
    sbRef.current = client;
    getJobByQuote.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
    getInvoiceByJob.mockResolvedValue({ id: 'inv-1', status: 'cancelled', balance: 1350 });

    const res = await POST(signedReq(BAL_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ignored).toBe('invoice-cancelled');
    expect(updatePayloads).toHaveLength(0); // invoice NOT touched
    expect(setJobStatus).not.toHaveBeenCalled(); // job NOT closed
  });
});
