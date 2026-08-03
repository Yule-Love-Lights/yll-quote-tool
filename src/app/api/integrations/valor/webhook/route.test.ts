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
import type { RegisterCardInVaultResult } from '@/lib/integrations/valorVault';

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
  accrueOnBooking,
  ensureReferralCode,
  registerCardInVault,
  vaultEnabled,
} = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  hl: {
    sendSms: vi.fn(async () => ({})),
    sendEmail: vi.fn(async () => ({})),
    updateOpportunity: vi.fn(async () => ({})),
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
  // Referral program (#41): mocked so the webhook test asserts the wiring
  // (called once per booking) without touching the referrals table. Its OWN
  // idempotency is covered in src/lib/referrals.test.ts.
  accrueOnBooking: vi.fn(async () => ({ accrued: false })),
  // Referral program (#41 PR 2): stamp-at-booking — mocked the same way.
  ensureReferralCode: vi.fn(async () => 'CODE1234'),
  // #161 "both vaults" decision: the vault-registration orchestrator + its
  // flag gate. Default OFF (mirrors the real flag being operator-armed) and a
  // default happy-path return, so every PRE-EXISTING test in this file is
  // unaffected unless a test explicitly flips `vaultEnabled.value = true`.
  registerCardInVault: vi.fn(
    async (): Promise<RegisterCardInVaultResult> => ({ ok: true, vaultCustomerId: 'vc-1', paymentId: 'pp-1' }),
  ),
  vaultEnabled: { value: false },
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
  updateOpportunity: hl.updateOpportunity,
  isHighLevelConfigured: () => hl.configured.value,
  HighLevelError: class HighLevelError extends Error {},
}));

vi.mock('@/lib/referrals', () => ({
  accrueOnBooking,
  ensureReferralCode,
}));

vi.mock('@/lib/integrations/valorVault', () => ({
  registerCardInVault,
  isVaultRegisterEnabled: () => vaultEnabled.value,
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
    in: () => builder,
    or: () => builder,
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
  amount: '135000', // Valor reports CENTS → $1350.00 (parseWebhookEvent ÷100)
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
  valor_txn_id: null,
  approval_snapshot: { customerSelection: { currentTotalUsd: 2700, currentDepositUsd: 1350 } },
  customer_id: null,
  valor_vault_customer_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  hl.configured.value = true;
  vaultEnabled.value = false;
  process.env.VALOR_WEBHOOK_SECRET = SECRET;
  process.env.HIGHLEVEL_STAGE_QUOTE_APPROVED = 'stage-approved';
  process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
  process.env.PORTAL_BASE_URL = 'https://quote.example.com';
});

describe('Valor webhook — happy path', () => {
  // #161 regression: the signed TRANSACTION webhook is TOKENLESS (confirmed
  // live 2026-07-22) while the redirect_url capture route persists the real
  // token to quotes.valor_vault_token ~a minute EARLIER. An unconditional
  // `valor_vault_token: event.vaultToken` in the booking stamp wrote the
  // parser's explicit null over that just-saved token. The stamp must OMIT the
  // column entirely when the webhook carried no token.
  it('does NOT touch valor_vault_token when the webhook carries no token', async () => {
    const { client, updatePayloads } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const tokenless: Record<string, unknown> = { ...APPROVED_PAYLOAD };
    delete tokenless.vault_token;
    const res = await POST(signedReq(tokenless));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0].deposit_paid_at).toBeTruthy();
    expect(Object.keys(updatePayloads[0])).not.toContain('valor_vault_token');
  });

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

    // CRM move + reset the card value to the customer's approved selection (#107)
    // + customer receipt (sms + email) + internal "paid" email
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp-1', {
      pipelineStageId: 'stage-approved',
      monetaryValue: 2700, // approval_snapshot.customerSelection.currentTotalUsd
    });
    expect(hl.sendSms).toHaveBeenCalledTimes(1);
    expect(hl.sendEmail).toHaveBeenCalledTimes(2); // customer receipt + internal alert

    // #83 Phase 2: booking auto-creates exactly one Job from the quote.
    expect(createJobFromQuote).toHaveBeenCalledTimes(1);
    expect(createJobFromQuote).toHaveBeenCalledWith('quote-1');

    // #41 referral program: the booking event fires the accrual exactly once.
    expect(accrueOnBooking).toHaveBeenCalledTimes(1);
    expect(accrueOnBooking).toHaveBeenCalledWith('quote-1');

    // #82 follow-up: a proactive prep ping fires once, listing the job's materials.
    expect(getJobWorkOrder).toHaveBeenCalledWith('job-1');
    expect(notifyTelegram).toHaveBeenCalledTimes(1);
    expect(notifyTelegram.mock.calls[0][0]).toContain('New job to prep');
    expect(notifyTelegram.mock.calls[0][0]).toContain('Jordan Smith');
    expect(notifyTelegram.mock.calls[0][0]).toContain('C9 Warm White');
  });

  it('#159: books a quote from the REAL Valor E-Invoice shape (ref nested at data.invoice_no)', async () => {
    // Regression for the first-real-payment incident (2026-07-17): Valor's
    // hosted-page / E-Invoice confirmation webhook nests the transaction under
    // `data` and echoes our order ref as `data.invoice_no` (NOT `invoicenumber`).
    // That field was absent from parseWebhookEvent's pick-list, so a real deposit
    // charged fine but the webhook saw hasOrderRef:false and IGNORED it → the
    // quote never auto-booked. This pins the exact production payload now books.
    const { client, updatePayloads } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const realShape = {
      data: {
        txn_id: 'TXN-REAL',
        response_code: '00',
        amount: '48938', // cents → $489.38
        approval_code: 'AUTH42',
        receipt_url: 'https://valor/receipt/real',
        invoice_no: 'qaf7affe2379dfd8a', // our valor_order_ref, echoed here
      },
    };

    const res = await POST(signedReq(realShape));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0].deposit_paid_at).toBeTruthy();
    expect(updatePayloads[0].valor_txn_id).toBe('TXN-REAL');
    expect(createJobFromQuote).toHaveBeenCalledWith('quote-1');
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

  it('still books even if the referral accrual throws (fail-open, #41)', async () => {
    const { client } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;
    accrueOnBooking.mockRejectedValueOnce(new Error('referrals table missing'));

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true); // payment recorded despite the accrual failure
  });

  // #41 PR 2: stamp-at-booking — every future customer gets their referral
  // link live in GHL from the moment they're booked via a real Valor payment.
  it('stamps the referral code for the quote\'s OWN linked customer on booking', async () => {
    const { client } = makeSb({ ...QUOTE, customer_id: 'cust-1' }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    expect(res.status).toBe(200);
    expect(ensureReferralCode).toHaveBeenCalledWith('cust-1');
  });

  it('skips the referral code stamp when the quote has no linked customer', async () => {
    const { client } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    expect(res.status).toBe(200);
    expect(ensureReferralCode).not.toHaveBeenCalled();
  });

  it('still books even if the referral code stamp throws (fail-open, #41 PR 2)', async () => {
    const { client } = makeSb({ ...QUOTE, customer_id: 'cust-1' }, [{ id: 'quote-1' }]);
    sbRef.current = client;
    ensureReferralCode.mockRejectedValueOnce(new Error('referrals table missing'));

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
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

describe('Valor webhook — deposit amount (records actual charged, flags shortfall)', () => {
  it('records the actual amount when it matches the intended deposit', async () => {
    const { client, updatePayloads } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;
    const res = await POST(signedReq(APPROVED_PAYLOAD)); // 135000 cents = $1350 == intended 1350
    expect(res.status).toBe(200);
    expect(updatePayloads[0].deposit_amount_usd).toBe(1350);
  });

  it('records the ACTUAL (lower) amount + warns on a partial authorization, and STILL books', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { client, updatePayloads } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;
    const res = await POST(signedReq({ ...APPROVED_PAYLOAD, amount: '100000' })); // cents → $1000
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
    // credits what was REALLY charged (1000), not the intended 1350 → truthful balance
    expect(updatePayloads[0].deposit_amount_usd).toBe(1000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('deposit shortfall'));
    warn.mockRestore();
  });

  it('keeps the intended amount when the webhook carries no amount (no null overwrite)', async () => {
    const { client, updatePayloads } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;
    const noAmount: Record<string, unknown> = { ...APPROVED_PAYLOAD };
    delete noAmount.amount;
    const res = await POST(signedReq(noAmount));
    expect(res.status).toBe(200);
    expect(updatePayloads[0].deposit_amount_usd).toBe(1350);
  });
});

// #177 fix 2c: the internal "paid" alert must read the FROZEN deposit percent
// from the approval snapshot (what the customer actually approved with), not
// the live result.depositRate, which could have drifted since approval.
describe('Valor webhook — internal alert reads the FROZEN deposit percent (#177 fix 2c)', () => {
  it('prefers approval_snapshot.customerSelection.depositRate over a different live result.depositRate', async () => {
    const quote = {
      ...QUOTE,
      result: { ...QUOTE.result, depositRate: 0.5 }, // live rate says 50% — must NOT win
      approval_snapshot: {
        customerSelection: { currentTotalUsd: 2700, currentDepositUsd: 675, depositRate: 0.25 },
      },
    };
    const { client } = makeSb({ ...quote }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    await POST(signedReq(APPROVED_PAYLOAD));

    // Only internalPaidEmailHtml's copy mentions a deposit percent (the customer
    // receipt email doesn't), so matching on the html substring uniquely proves
    // the internal alert froze the right rate without indexing a specific call.
    expect(hl.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.stringContaining('paid their 25% deposit') }),
    );
  });

  it('falls back to the live result.depositRate for a pre-#177 snapshot with no frozen rate', async () => {
    const quote = {
      ...QUOTE,
      result: { ...QUOTE.result, depositRate: 0.3 },
      approval_snapshot: { customerSelection: { currentTotalUsd: 2700, currentDepositUsd: 810 } }, // no depositRate field
    };
    const { client } = makeSb({ ...quote }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    await POST(signedReq(APPROVED_PAYLOAD));

    expect(hl.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.stringContaining('paid their 30% deposit') }),
    );
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
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });
});

describe('Valor webhook — idempotency (the fix)', () => {
  it('does NOT double-fire side effects when the atomic claim loses the race', async () => {
    // Conditional update returns 0 rows → a concurrent retry of the SAME txn
    // already claimed it (valor_txn_id matches the incoming event — W1-006 must
    // NOT flag this as a duplicate).
    const { client } = makeSb({ ...QUOTE, valor_txn_id: 'TXN-123' }, []);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.alreadyPaid).toBe(true);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
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

describe('Valor webhook — possible double charge (W1-006)', () => {
  it('SAME txn id retry on an already-paid quote stays a silent alreadyPaid ack (no marker, no email)', async () => {
    const { client, updatePayloads } = makeSb(
      { ...QUOTE, deposit_paid_at: '2026-06-25T00:00:00Z', valor_txn_id: 'TXN-123' },
      [],
    );
    sbRef.current = client;

    // Same txn id as the one already on file — a normal Valor retry.
    const res = await POST(signedReq(APPROVED_PAYLOAD)); // txn_id: 'TXN-123'
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.alreadyPaid).toBe(true);
    expect(updatePayloads).toHaveLength(0); // no approval_snapshot write
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('DISTINCT txn id on an already-paid quote stamps duplicatePayment + emails staff, still 200-acks', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, updatePayloads } = makeSb(
      {
        ...QUOTE,
        deposit_paid_at: '2026-06-25T00:00:00Z',
        valor_txn_id: 'TXN-ORIGINAL',
        approval_snapshot: { customerSelection: { currentTotalUsd: 2700 }, signature: 'sig-data' },
      },
      [],
    );
    sbRef.current = client;

    // A different txn id — a genuinely second approved charge (two open tabs).
    const res = await POST(signedReq({ ...APPROVED_PAYLOAD, txn_id: 'TXN-SECOND' }));
    const json = await res.json();

    expect(res.status).toBe(200); // still ack so Valor doesn't retry
    expect(json.alreadyPaid).toBe(true);

    // Merge-stamped into approval_snapshot — existing keys preserved.
    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0]).toMatchObject({
      approval_snapshot: {
        customerSelection: { currentTotalUsd: 2700 },
        signature: 'sig-data',
        duplicatePayment: { txnId: 'TXN-SECOND' },
      },
    });

    expect(hl.sendEmail).toHaveBeenCalledTimes(1);
    expect(hl.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'internal-1', subject: expect.stringContaining('Jordan Smith') }),
    );
    expect(err).toHaveBeenCalledWith(expect.stringContaining('POSSIBLE DOUBLE CHARGE'));
    err.mockRestore();
  });

  it('DISTINCT txn id racing the atomic claim (lost-race path) also flags the duplicate', async () => {
    const { client, updatePayloads } = makeSb(
      { ...QUOTE, valor_txn_id: 'TXN-ORIGINAL' }, // deposit_paid_at NULL when read, but claim loses the race
      [], // 0 rows claimed → another request already booked it
    );
    sbRef.current = client;

    const res = await POST(signedReq({ ...APPROVED_PAYLOAD, txn_id: 'TXN-SECOND' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.alreadyPaid).toBe(true);
    // First updatePayload is the failed atomic-claim attempt; second is the duplicate marker.
    expect(updatePayloads).toHaveLength(2);
    expect(updatePayloads[1]).toMatchObject({
      approval_snapshot: { duplicatePayment: { txnId: 'TXN-SECOND' } },
    });
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('does not fail the webhook when the duplicate-payment alert email throws (best-effort)', async () => {
    const { client } = makeSb(
      { ...QUOTE, deposit_paid_at: '2026-06-25T00:00:00Z', valor_txn_id: 'TXN-ORIGINAL' },
      [],
    );
    sbRef.current = client;
    hl.sendEmail.mockRejectedValueOnce(new Error('GHL down'));

    const res = await POST(signedReq({ ...APPROVED_PAYLOAD, txn_id: 'TXN-SECOND' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.alreadyPaid).toBe(true);
  });
});

describe('Valor webhook — dead-quote guard (W1-007)', () => {
  it('does NOT book a CANCELLED quote even on an approved deposit txn (loud log, no side effects)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A cancelled order still holding a live pay link (deposit_paid_at NULL) — only
    // the status gate stops the resurrection to 'booked'.
    const { client, updatePayloads } = makeSb({ ...QUOTE, status: 'cancelled' }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200); // ack so Valor stops retrying
    expect(json.booked).toBe(false);
    expect(json.ignored).toBe('quote-cancelled');
    // NEVER wrote deposit_paid_at / status='booked', and fired no side effects.
    expect(updatePayloads).toHaveLength(0);
    expect(createJobFromQuote).not.toHaveBeenCalled();
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(notifyTelegram).not.toHaveBeenCalled();
    // Loud error log — real money may have moved, staff must reconcile.
    expect(err).toHaveBeenCalledWith(expect.stringContaining('NOT booking a dead order'));
    err.mockRestore();
  });

  it('still books a normal approved quote (status="approved") — guard is transparent', async () => {
    const { client, updatePayloads } = makeSb({ ...QUOTE, status: 'approved' }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
    expect(updatePayloads[0].status).toBe('booked');
  });
});

describe('Valor webhook — per-service-type pipeline (#GHL pipeline sync)', () => {
  it('holiday still moves the card via the legacy HIGHLEVEL_STAGE_QUOTE_APPROVED env var (byte-equivalent prod behavior)', async () => {
    const { client } = makeSb({ ...QUOTE, service_type: 'holiday' }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp-1', {
      pipelineStageId: 'stage-approved', // from HIGHLEVEL_STAGE_QUOTE_APPROVED
      monetaryValue: 2700,
    });
  });

  it('a permanent quote moves its card to the PERMANENT pipeline\'s "Closed" stage, ignoring the legacy env var', async () => {
    const { client } = makeSb({ ...QUOTE, service_type: 'permanent' }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    expect(res.status).toBe(200);
    // HIGHLEVEL_STAGE_QUOTE_APPROVED is set to 'stage-approved' in beforeEach — a
    // permanent quote must NOT use it.
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp-1', {
      pipelineStageId: 'f4bfe29f-5d5a-4725-a6d2-1f5f19ec4010', // Closed
      monetaryValue: 2700,
    });
  });

  it('an event quote moves its card to the EVENT pipeline\'s "Booked" stage', async () => {
    const { client } = makeSb({ ...QUOTE, service_type: 'event' }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp-1', {
      pipelineStageId: '4f6a7739-9bc9-4c27-a140-1ca9f58798fd', // Booked
      monetaryValue: 2700,
    });
  });

  it('legacy_rebook (#156): a legacy rebook holiday quote moves its card to the Neighbors Booked stage, NOT the legacy env-configured holiday stage', async () => {
    const { client } = makeSb({ ...QUOTE, service_type: 'holiday', legacy_rebook: true }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp-1', {
      pipelineStageId: 'da6521b1-b945-4484-8251-6c6dc487c860', // Booked (Neighbors)
      monetaryValue: 2700,
    });
  });

  it('a missing service_type (legacy row) defaults to holiday and still honors the env var', async () => {
    const { client } = makeSb({ ...QUOTE, service_type: null }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    expect(res.status).toBe(200);
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp-1', {
      pipelineStageId: 'stage-approved',
      monetaryValue: 2700,
    });
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
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });

  it('acknowledges a declined transaction without booking it, but stamps the decline + alerts staff (#175)', async () => {
    const { client, updatePayloads } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq({ ...APPROVED_PAYLOAD, response_code: '05' }));
    const json = await res.json();

    expect(json.booked).toBe(false);
    expect(json.declined).toBe(true);
    // never stamped paid/booked
    expect(updatePayloads.every((p) => !('deposit_paid_at' in p) && !('status' in p))).toBe(true);
    expect(hl.sendSms).not.toHaveBeenCalled();
    // #175: fill-always decline stamp, then the guarded notify claim.
    expect(updatePayloads[0]).toMatchObject({
      deposit_declined_at: expect.any(String),
      deposit_decline_code: '05',
    });
    expect(updatePayloads[1]).toMatchObject({ deposit_decline_notified_at: expect.any(String) });
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);
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
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
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

  it('#170(a): settling over a FRESH operator charge-in-flight sentinel still settles but ALERTS (likely double charge)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, updatePayloads } = makeSb(
      { id: 'quote-1', customer_name: 'Jordan Smith', is_test: false, approval_snapshot: {} },
      [{ id: 'inv-1' }],
    );
    sbRef.current = client;
    getJobByQuote.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
    getInvoiceByJob.mockResolvedValue({
      id: 'inv-1',
      status: 'awaiting_payment',
      balance: 1350,
      // The operator's charge-balance leg claimed the slot moments ago — its
      // Valor charge may land too, so this settle is a likely double charge.
      valor_balance_txn_id: `pending:${new Date().toISOString()}`,
    });

    const res = await POST(signedReq(BAL_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    // The customer's money is real — the settle itself proceeds…
    expect(json).toMatchObject({ balance: true, paid: true });
    expect(updatePayloads[0]).toMatchObject({ status: 'paid', balance: 0 });
    // …but staff get the proactive duplicate alert instead of silence.
    expect(hl.sendEmail).toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(expect.stringContaining('IN FLIGHT'));
    err.mockRestore();
  });

  it('does NOT settle on an underpayment (paid amount < balance), but WT-15 stamps a durable shortfall marker', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, updatePayloads } = makeSb(
      { id: 'quote-1', customer_name: 'Jordan Smith', is_test: false, approval_snapshot: { foo: 'bar' } },
      [{ id: 'inv-1' }],
    );
    sbRef.current = client;
    getJobByQuote.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
    getInvoiceByJob.mockResolvedValue({ id: 'inv-1', status: 'awaiting_payment', balance: 1350 });

    const res = await POST(signedReq({ ...BAL_PAYLOAD, amount: '100' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.underpaid).toBe(true);
    expect(setJobStatus).not.toHaveBeenCalled();

    // WT-15: the invoice itself is never touched (no status/balance write) —
    // only a durable marker on the quote's approval_snapshot, preserving
    // existing keys, so the shortfall surfaces in-app.
    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0]).not.toHaveProperty('status');
    expect(updatePayloads[0]).toMatchObject({
      approval_snapshot: {
        foo: 'bar',
        balanceUnderpayment: { txnId: 'TXN-123', paidUsd: 1, expectedUsd: 1350, shortfallUsd: 1349 },
      },
    });

    // Best-effort staff alert.
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);
    expect(hl.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'internal-1', subject: expect.stringContaining('Jordan Smith') }),
    );
    expect(err).toHaveBeenCalledWith(expect.stringContaining('balance underpayment'));
    err.mockRestore();
  });

  it('does not fail the webhook when the underpayment alert email throws (best-effort)', async () => {
    const { client } = makeSb(
      { id: 'quote-1', customer_name: 'Jordan Smith', is_test: false, approval_snapshot: null },
      [{ id: 'inv-1' }],
    );
    sbRef.current = client;
    getJobByQuote.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
    getInvoiceByJob.mockResolvedValue({ id: 'inv-1', status: 'awaiting_payment', balance: 1350 });
    hl.sendEmail.mockRejectedValueOnce(new Error('GHL down'));

    const res = await POST(signedReq({ ...BAL_PAYLOAD, amount: '100' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.underpaid).toBe(true);
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
    // SAME txn id as the one already recorded on the invoice (a normal Valor
    // retry, not a genuinely distinct second charge) — must stay silent (WT-14).
    getInvoiceByJob.mockResolvedValue({ id: 'inv-1', status: 'paid', balance: 0, valor_balance_txn_id: 'TXN-123' });

    const res = await POST(signedReq(BAL_PAYLOAD)); // txn_id: 'TXN-123'
    const json = await res.json();

    expect(json.alreadyPaid).toBe(true);
    expect(updatePayloads).toHaveLength(0); // no duplicate-marker write
    expect(setJobStatus).not.toHaveBeenCalled();
    expect(hl.sendEmail).not.toHaveBeenCalled();
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

  // WT-14: the balance path had no duplicate-charge guard, unlike the deposit
  // path's flagPossibleDuplicatePayment (W1-006). A second APPROVED balance
  // webhook carrying a DIFFERENT txn id than the one recorded on the invoice is
  // a genuine second charge (two open pay-link tabs both got paid) and must be
  // flagged, not silently ack'd.
  describe('Valor webhook — balance possible double charge (WT-14)', () => {
    it('DISTINCT txn id on an already-paid invoice stamps duplicateBalancePayment + emails staff, does NOT re-settle', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const { client, updatePayloads } = makeSb(
        { id: 'quote-1', customer_name: 'Jordan Smith', is_test: false, approval_snapshot: { foo: 'bar' } },
        [],
      );
      sbRef.current = client;
      getJobByQuote.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
      getInvoiceByJob.mockResolvedValue({
        id: 'inv-1',
        status: 'paid',
        balance: 0,
        valor_balance_txn_id: 'TXN-ORIGINAL',
      });

      // A different txn id than the one on file — a genuinely second approved charge.
      const res = await POST(signedReq({ ...BAL_PAYLOAD, txn_id: 'TXN-SECOND' }));
      const json = await res.json();

      expect(res.status).toBe(200); // still ack so Valor doesn't retry
      expect(json.alreadyPaid).toBe(true);
      expect(setJobStatus).not.toHaveBeenCalled(); // invoice NOT re-settled/double-applied

      // Merge-stamped into the quote's approval_snapshot — existing keys preserved.
      expect(updatePayloads).toHaveLength(1);
      expect(updatePayloads[0]).toMatchObject({
        approval_snapshot: {
          foo: 'bar',
          duplicateBalancePayment: { txnId: 'TXN-SECOND' },
        },
      });

      expect(hl.sendEmail).toHaveBeenCalledTimes(1);
      expect(hl.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({ contactId: 'internal-1', subject: expect.stringContaining('Jordan Smith') }),
      );
      expect(err).toHaveBeenCalledWith(expect.stringContaining('POSSIBLE DOUBLE CHARGE (balance)'));
      err.mockRestore();
    });

    it('DISTINCT txn id racing the atomic claim (lost-race path) also flags the duplicate', async () => {
      const { client, updatePayloads } = makeSb(
        { id: 'quote-1', customer_name: 'Jordan Smith', is_test: false, approval_snapshot: null },
        [], // 0 rows claimed → another request already settled it
      );
      sbRef.current = client;
      getJobByQuote.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
      getInvoiceByJob.mockResolvedValue({
        id: 'inv-1',
        status: 'awaiting_payment', // unsettled when read; loses the claim below
        balance: 1350,
        valor_balance_txn_id: 'TXN-ORIGINAL',
      });

      const res = await POST(signedReq({ ...BAL_PAYLOAD, txn_id: 'TXN-SECOND' }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.alreadyPaid).toBe(true);
      // First updatePayload is the failed atomic-claim attempt on invoices;
      // second is the duplicate marker on the quote.
      expect(updatePayloads).toHaveLength(2);
      expect(updatePayloads[1]).toMatchObject({
        approval_snapshot: { duplicateBalancePayment: { txnId: 'TXN-SECOND' } },
      });
      expect(hl.sendEmail).toHaveBeenCalledTimes(1);
      expect(setJobStatus).not.toHaveBeenCalled();
    });

    it('SAME txn id retry on an already-paid invoice stays a silent alreadyPaid ack (no marker, no email)', async () => {
      const { client, updatePayloads } = makeSb({ id: 'quote-1', is_test: false }, []);
      sbRef.current = client;
      getJobByQuote.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
      getInvoiceByJob.mockResolvedValue({ id: 'inv-1', status: 'paid', balance: 0, valor_balance_txn_id: 'TXN-123' });

      const res = await POST(signedReq(BAL_PAYLOAD)); // txn_id: 'TXN-123'
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.alreadyPaid).toBe(true);
      expect(updatePayloads).toHaveLength(0);
      expect(hl.sendEmail).not.toHaveBeenCalled();
    });

    it('does not fail the webhook when the duplicate balance-payment alert email throws (best-effort)', async () => {
      const { client } = makeSb(
        { id: 'quote-1', customer_name: 'Jordan Smith', is_test: false, approval_snapshot: null },
        [],
      );
      sbRef.current = client;
      getJobByQuote.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
      getInvoiceByJob.mockResolvedValue({
        id: 'inv-1',
        status: 'paid',
        balance: 0,
        valor_balance_txn_id: 'TXN-ORIGINAL',
      });
      hl.sendEmail.mockRejectedValueOnce(new Error('GHL down'));

      const res = await POST(signedReq({ ...BAL_PAYLOAD, txn_id: 'TXN-SECOND' }));
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.alreadyPaid).toBe(true);
    });
  });
});

// #161 "both vaults" decision (2026-07-22): in ADDITION to the raw payment
// token already saved via the redirect_url capture route, Jason wants each
// card ALSO registered into Valor's OWN Vault product. registerCardInVault
// itself is unit-tested in valorVault.test.ts — these lock in the WIRING: the
// gate (flag + null column + a txn id), the fields passed through, the
// fill-null persistence, and that a vault hiccup (reason or a thrown error)
// never affects the booking response.
describe('Valor webhook — vault registration (#161 "both vaults" decision)', () => {
  it('flag OFF (default) → registerCardInVault is never called; booking proceeds normally', async () => {
    const { client } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
    expect(registerCardInVault).not.toHaveBeenCalled();
  });

  it('flag ON + null column + a txn id → registers with the quote\'s fields and persists the id (fill-null)', async () => {
    vaultEnabled.value = true;
    const { client, updatePayloads } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD)); // txn_id: 'TXN-123'
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
    expect(registerCardInVault).toHaveBeenCalledWith({
      customerName: 'Jordan Smith',
      email: 'jordan@example.com',
      phone: '+15551234567',
      txnId: 'TXN-123',
    });
    // The default mock resolves { ok:true, vaultCustomerId: 'vc-1' } — persisted
    // as a SEPARATE update from the booking stamp, fill-null on the vault column.
    const vaultUpdate = updatePayloads.find((p) => 'valor_vault_customer_id' in p);
    expect(vaultUpdate).toEqual({ valor_vault_customer_id: 'vc-1' });
  });

  it('the column is already set → registerCardInVault is never called (register-once guard)', async () => {
    vaultEnabled.value = true;
    const { client } = makeSb({ ...QUOTE, valor_vault_customer_id: 'vc-existing' }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    expect(res.status).toBe(200);
    expect(registerCardInVault).not.toHaveBeenCalled();
  });

  it('the event carries no txn id → registerCardInVault is never called', async () => {
    vaultEnabled.value = true;
    const { client } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const noTxn: Record<string, unknown> = { ...APPROVED_PAYLOAD };
    delete noTxn.txn_id;
    const res = await POST(signedReq(noTxn));

    expect(res.status).toBe(200);
    expect(registerCardInVault).not.toHaveBeenCalled();
  });

  it('registerCardInVault resolves ok:false → booking still 200, notifications unaffected, and "vault register failed" is logged', async () => {
    vaultEnabled.value = true;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    registerCardInVault.mockResolvedValueOnce({ ok: false, reason: 'addcustomer failed: 500' });
    const { client, updatePayloads } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
    // #171f: a vault failure must never affect the notifications it now runs
    // AFTER — they already settled by the time the vault hook even starts.
    expect(json.customerSmsSent).toBe(true);
    expect(json.customerEmailSent).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('vault register failed'));
    // No vault-column write when registration failed.
    expect(updatePayloads.some((p) => 'valor_vault_customer_id' in p)).toBe(false);
    warn.mockRestore();
  });

  it('registerCardInVault THROWS (belt-and-suspenders) → booking still 200', async () => {
    vaultEnabled.value = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    registerCardInVault.mockRejectedValueOnce(new Error('unexpected crash'));
    const { client } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
    expect(err).toHaveBeenCalledWith(expect.stringContaining('vault register failed'));
    err.mockRestore();
  });

  // #171f: the vault hook used to run BEFORE the customer receipt SMS/email —
  // its 2×15s timeout budget (addcustomer + addpaymentprofiletxn, see
  // valorVault.ts) could delay the customer's booking confirmation by up to
  // ~30s whenever Valor's Vault API was slow. It's now reordered to run AFTER
  // the notification batch settles (still awaited, not fire-and-forget).
  it('runs AFTER the customer notifications settle, not before or concurrently', async () => {
    vaultEnabled.value = true;
    const order: string[] = [];
    const delayedPush = (label: string) => async () => {
      await new Promise((r) => setTimeout(r, 10));
      order.push(label);
      return {};
    };
    hl.sendSms.mockImplementationOnce(delayedPush('sms'));
    hl.sendEmail.mockImplementationOnce(delayedPush('email:customer'));
    hl.sendEmail.mockImplementationOnce(delayedPush('email:internal'));
    registerCardInVault.mockImplementationOnce(async () => {
      order.push('vault');
      return { ok: true, vaultCustomerId: 'vc-1' };
    });

    const { client } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq(APPROVED_PAYLOAD));
    expect(res.status).toBe(200);

    // Vault ran dead last — i.e. only after EVERY notification had fully
    // settled (not merely started), proving it's a sequential await after the
    // Promise.allSettled batch rather than folded into it.
    expect(order[order.length - 1]).toBe('vault');
    expect(order.slice(0, -1).sort()).toEqual(['email:customer', 'email:internal', 'sms']);
  });
});

describe('Valor webhook — declined deposit staff alert (#175)', () => {
  it('throttles a second decline within the hour: the stamp still updates but NO second email fires', async () => {
    // Shared reference so we can flip the mock's "claim result" mid-test —
    // the FIRST decline wins the notify claim (email fires); the SECOND
    // simulates the guarded update losing the race (still inside the
    // throttle window, or a concurrent delivery already claimed it).
    const claimRows = [{ id: 'quote-1' }];
    const { client, updatePayloads } = makeSb({ ...QUOTE }, claimRows);
    sbRef.current = client;

    const res1 = await POST(signedReq({ ...APPROVED_PAYLOAD, response_code: '05' }));
    expect((await res1.json()).declined).toBe(true);
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);

    claimRows.length = 0; // the notify claim now matches 0 rows
    const res2 = await POST(signedReq({ ...APPROVED_PAYLOAD, response_code: '05' }));
    expect((await res2.json()).declined).toBe(true);

    // Both deliveries still stamped the decline (fill-always)...
    const stampUpdates = updatePayloads.filter((p) => 'deposit_declined_at' in p);
    expect(stampUpdates).toHaveLength(2);
    // ...but only the first delivery's alert actually sent.
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('an already-paid quote receiving a declined webhook is never stamped or alerted (the existing alreadyPaid guard fires first)', async () => {
    const { client, updatePayloads } = makeSb(
      { ...QUOTE, deposit_paid_at: '2026-07-01T00:00:00Z' },
      [{ id: 'quote-1' }],
    );
    sbRef.current = client;

    const res = await POST(signedReq({ ...APPROVED_PAYLOAD, response_code: '05' }));
    const json = await res.json();

    expect(json).toMatchObject({ booked: true, alreadyPaid: true });
    expect(updatePayloads).toHaveLength(0);
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('no HighLevel internal contact configured → still stamps the decline but never calls sendEmail', async () => {
    delete process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
    const { client, updatePayloads } = makeSb({ ...QUOTE }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    const res = await POST(signedReq({ ...APPROVED_PAYLOAD, response_code: '05' }));
    expect((await res.json()).declined).toBe(true);
    expect(updatePayloads.some((p) => 'deposit_declined_at' in p)).toBe(true);
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('the alert subject/body carry the customer, quote number, amount, and a human decline-code translation', async () => {
    const { client } = makeSb({ ...QUOTE, quote_number: 4242 }, [{ id: 'quote-1' }]);
    sbRef.current = client;

    await POST(signedReq({ ...APPROVED_PAYLOAD, response_code: '51' }));

    expect(hl.sendEmail).toHaveBeenCalledTimes(1);
    expect(hl.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('DECLINED') }),
    );
    expect(hl.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('quote #4242') }),
    );
    // code 51's human translation
    expect(hl.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.stringContaining('Insufficient funds') }),
    );
    expect(hl.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.stringContaining('/admin/quotes/quote-1') }),
    );
    expect(hl.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.stringContaining('/portal/quote-1') }),
    );
  });
});

describe('Valor webhook — declined BALANCE staff alert (#175)', () => {
  const BAL_ID = '8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60';
  const DECLINED_BAL_PAYLOAD = { ...APPROVED_PAYLOAD, response_code: '05', order_id: `bal_${BAL_ID}` };

  it('stamps the SAME quote columns + alerts staff (anchored on the quote, not the invoice), without touching the invoice/job', async () => {
    const { client, updatePayloads } = makeSb(
      { id: BAL_ID, customer_name: 'Jordan Smith', is_test: false, quote_number: 99, approval_snapshot: {} },
      [{ id: BAL_ID }],
    );
    sbRef.current = client;
    getJobByQuote.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
    getInvoiceByJob.mockResolvedValue({ id: 'inv-1', status: 'awaiting_payment', balance: 1350 });

    const res = await POST(signedReq(DECLINED_BAL_PAYLOAD));
    const json = await res.json();

    expect(json).toMatchObject({ balance: true, declined: true });
    expect(updatePayloads[0]).toMatchObject({
      deposit_declined_at: expect.any(String),
      deposit_decline_code: '05',
    });
    expect(updatePayloads[1]).toMatchObject({ deposit_decline_notified_at: expect.any(String) });
    expect(setJobStatus).not.toHaveBeenCalled(); // a decline changes nothing about what's owed
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);
    expect(hl.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ subject: expect.stringContaining('balance') }),
    );
    // links to the invoice, not the quote page
    expect(hl.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.stringContaining('/admin/invoices/inv-1') }),
    );
  });

  it('falls back to the admin quote page link when there is no linked invoice', async () => {
    const { client } = makeSb(
      { id: BAL_ID, customer_name: 'Jordan Smith', is_test: false, approval_snapshot: {} },
      [{ id: BAL_ID }],
    );
    sbRef.current = client;
    getJobByQuote.mockResolvedValue(null);

    await POST(signedReq(DECLINED_BAL_PAYLOAD));

    expect(hl.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ html: expect.stringContaining(`/admin/quotes/${BAL_ID}`) }),
    );
  });

  it('ignores a TEST quote — no stamp, no alert', async () => {
    const { client, updatePayloads } = makeSb({ id: BAL_ID, is_test: true }, [{ id: BAL_ID }]);
    sbRef.current = client;

    const res = await POST(signedReq(DECLINED_BAL_PAYLOAD));
    expect((await res.json()).declined).toBe(true);
    expect(updatePayloads).toHaveLength(0);
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  // #175 review MED: Valor's decline + success webhooks are separate
  // deliveries with no ordering guarantee — a decline that arrives AFTER the
  // invoice already settled (or was cancelled) must not stamp/alert, since
  // "No money moved… retry the link" would be flat wrong by then.
  it('an already-PAID balance invoice is not stamped or alerted — the decline arrived after the money already moved', async () => {
    const { client, updatePayloads } = makeSb(
      { id: BAL_ID, customer_name: 'Jordan Smith', is_test: false, approval_snapshot: {} },
      [{ id: BAL_ID }],
    );
    sbRef.current = client;
    getJobByQuote.mockResolvedValue({ id: 'job-1', status: 'done' });
    getInvoiceByJob.mockResolvedValue({ id: 'inv-1', status: 'paid', balance: 0 });

    const res = await POST(signedReq(DECLINED_BAL_PAYLOAD));
    const json = await res.json();

    expect(json).toMatchObject({ ok: true, balance: true, declined: true }); // ack unchanged
    expect(updatePayloads).toHaveLength(0);
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('a CANCELLED balance invoice is also not stamped or alerted — nothing left to retry', async () => {
    const { client, updatePayloads } = makeSb(
      { id: BAL_ID, customer_name: 'Jordan Smith', is_test: false, approval_snapshot: {} },
      [{ id: BAL_ID }],
    );
    sbRef.current = client;
    getJobByQuote.mockResolvedValue({ id: 'job-1', status: 'cancelled' });
    getInvoiceByJob.mockResolvedValue({ id: 'inv-1', status: 'cancelled', balance: 1350 });

    const res = await POST(signedReq(DECLINED_BAL_PAYLOAD));
    const json = await res.json();

    expect(json).toMatchObject({ ok: true, balance: true, declined: true });
    expect(updatePayloads).toHaveLength(0);
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('an invoice lookup failure is ambiguous — warns, skips the email, but still stamps the decline (fail-open toward silence, not a false alert)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client, updatePayloads } = makeSb(
      { id: BAL_ID, customer_name: 'Jordan Smith', is_test: false, approval_snapshot: {} },
      [{ id: BAL_ID }],
    );
    sbRef.current = client;
    getJobByQuote.mockRejectedValueOnce(new Error('supabase timeout'));

    const res = await POST(signedReq(DECLINED_BAL_PAYLOAD));
    const json = await res.json();

    expect(json).toMatchObject({ ok: true, balance: true, declined: true });
    expect(updatePayloads).toHaveLength(1);
    expect(updatePayloads[0]).toMatchObject({
      deposit_declined_at: expect.any(String),
      deposit_decline_code: '05',
    });
    expect(hl.sendEmail).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('balance decline invoice lookup failed'),
      expect.anything(),
    );
    err.mockRestore();
  });
});
