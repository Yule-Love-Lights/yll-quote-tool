// Tests for POST /api/quotes/[id]/convert-to-job (#83 ops).
//
// An operator books an approved quote by recording a manual deposit (no Valor
// charge). Money-safety guards:
//   - depositUsd >= 0 required; negative/missing/NaN → 400
//   - depositUsd clamped to quote.total (can't over-record a deposit)
//   - the booking write is atomic (.is('deposit_paid_at', null)) — double-click
//     yields one booking + one idempotent no-op, never two writes
//   - not-yet-approved quote → 409 (the gate is customer_approved_at, not status)
//   - already-booked → 200 { alreadyBooked:true } (idempotent, no duplicate write)
//   - createJobFromQuote is called exactly ONCE on a real booking; idempotent on retry

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const {
  createJobFromQuote,
  requireOperatorMock,
  sbRef,
  accrueOnBooking,
  ensureReferralCode,
  hl,
  resolvePipelineStagesMock,
} = vi.hoisted(() => ({
  createJobFromQuote: vi.fn(),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  sbRef: { current: null as unknown },
  accrueOnBooking: vi.fn(async () => ({ accrued: false })),
  ensureReferralCode: vi.fn(async () => 'CODE1234'),
  // GHL pipeline sync (booking bug batch 2026-07-17) — mirrors how the Valor
  // webhook's own test mocks updateOpportunity / isHighLevelConfigured.
  hl: {
    updateOpportunity: vi.fn(async () => ({})),
    configured: { value: true },
  },
  // Unlike the webhook test (which exercises the REAL ghlPipelineMap against
  // known env-var/stage-id fallbacks), this route's tests mock
  // resolvePipelineStages directly so the legacy-rebook assertion can check
  // its call args (legacyRebook passthrough) without coupling to real GHL ids.
  resolvePipelineStagesMock: vi.fn(() => ({
    pipelineId: 'pipe-1',
    entry: 'stage-entry',
    sent: 'stage-sent',
    depositPaid: 'stage-deposit-paid',
    installed: 'stage-installed',
    declined: 'stage-declined',
  })),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/jobs', () => ({ createJobFromQuote }));
vi.mock('@/lib/referrals', () => ({ accrueOnBooking, ensureReferralCode }));
vi.mock('@/lib/integrations/highlevel', () => ({
  updateOpportunity: hl.updateOpportunity,
  isHighLevelConfigured: () => hl.configured.value,
}));
vi.mock('@/lib/integrations/ghlPipelineMap', () => ({
  resolvePipelineStages: resolvePipelineStagesMock,
}));

import { POST } from './route';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const JOB_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

function makeReq(body: Record<string, unknown>): NextRequest {
  return {
    json: async () => body,
    headers: { get: () => null },
  } as unknown as NextRequest;
}
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

// Build a chainable Supabase mock:
//   .from().select().eq().maybeSingle() → resolves the quote row
//   .from().update().eq().is().select() → resolves the update (thenable)
// updateRows controls whether the booking write claims rows (real) or [] (raced).
function makeSb(
  quote: Record<string, unknown> | null,
  updateRows: Array<{ id: string }> | null = [{ id: ID }],
) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  let pendingIsUpdate = false;

  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    update: (payload: Record<string, unknown>) => {
      pendingIsUpdate = true;
      updatePayloads.push(payload);
      return builder;
    },
    eq: () => builder,
    is: () => builder,
    or: () => builder, // #124: booking-write status guard clause
    maybeSingle: async () => ({ data: quote, error: null }),
    // .select('id') after .update().eq().is() terminates the update chain
    then: (resolve: (v: unknown) => void) => {
      const isUpd = pendingIsUpdate;
      pendingIsUpdate = false;
      resolve(isUpd ? { data: updateRows, error: null } : { data: quote, error: null });
    },
  });
  return { client: builder, updatePayloads };
}

const BASE_QUOTE = {
  id: ID,
  customer_approved_at: '2026-07-01T00:00:00Z',
  deposit_paid_at: null,
  total: 1000,
  is_test: false,
  // No customer Valor checkout in flight — the in-flight guard doesn't fire.
  valor_order_ref: null,
  customer_id: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  createJobFromQuote.mockResolvedValue({ id: JOB_ID, status: 'to_schedule' });
  hl.configured.value = true;
  hl.updateOpportunity.mockResolvedValue({});
  resolvePipelineStagesMock.mockReturnValue({
    pipelineId: 'pipe-1',
    entry: 'stage-entry',
    sent: 'stage-sent',
    depositPaid: 'stage-deposit-paid',
    installed: 'stage-installed',
    declined: 'stage-declined',
  });
});

describe('POST /api/quotes/[id]/convert-to-job', () => {
  it('400s on an invalid UUID', async () => {
    const res = await POST(makeReq({ depositUsd: 0 }), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('400s when depositUsd is missing', async () => {
    const { client } = makeSb(BASE_QUOTE);
    sbRef.current = client;
    const res = await POST(makeReq({}), ctx());
    expect(res.status).toBe(400);
    expect(createJobFromQuote).not.toHaveBeenCalled();
  });

  it('400s when depositUsd is negative', async () => {
    const { client } = makeSb(BASE_QUOTE);
    sbRef.current = client;
    const res = await POST(makeReq({ depositUsd: -10 }), ctx());
    expect(res.status).toBe(400);
  });

  it('400s when depositUsd is NaN', async () => {
    const { client } = makeSb(BASE_QUOTE);
    sbRef.current = client;
    const res = await POST(makeReq({ depositUsd: 'not-a-number' }), ctx());
    expect(res.status).toBe(400);
  });

  it('404s when the quote does not exist', async () => {
    const { client } = makeSb(null);
    sbRef.current = client;
    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    expect(res.status).toBe(404);
  });

  it('409s when the quote is not yet approved (customer_approved_at null)', async () => {
    const { client } = makeSb({ ...BASE_QUOTE, customer_approved_at: null });
    sbRef.current = client;
    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('not-approved');
    expect(createJobFromQuote).not.toHaveBeenCalled();
  });

  it('#124: 409s when the quote was DECLINED after approval (status=declined, customer_approved_at still set) — never re-books a dead quote', async () => {
    // approved→declined is now legal (#124), so a declined quote keeps
    // customer_approved_at with deposit_paid_at NULL. The raw-column gate alone
    // would let it through; the deriveStatus terminal guard blocks it.
    const { client } = makeSb({ ...BASE_QUOTE, status: 'declined' });
    sbRef.current = client;
    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('not-bookable');
    expect(createJobFromQuote).not.toHaveBeenCalled();
  });

  it('409s (payment-in-flight) when a customer Valor checkout is in progress — no booking write, no job created', async () => {
    // Approved, deposit not yet paid, but valor_order_ref set = a customer
    // hosted-page checkout was started. Booking now would race the webhook and
    // could drop the real payment, so we refuse.
    const { client, updatePayloads } = makeSb({ ...BASE_QUOTE, valor_order_ref: 'ord_abc' });
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('payment-in-flight');
    // No booking write and no job creation — the operator reconciles first.
    expect(updatePayloads).toHaveLength(0);
    expect(createJobFromQuote).not.toHaveBeenCalled();
  });

  it('409s (payment-in-flight) when force is not true — no bypass', async () => {
    const { client, updatePayloads } = makeSb({ ...BASE_QUOTE, valor_order_ref: 'ord_abc' });
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 250, force: false }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('payment-in-flight');
    expect(updatePayloads).toHaveLength(0);
    expect(createJobFromQuote).not.toHaveBeenCalled();
  });

  it('force:true bypasses the in-flight guard — books + creates the job (abandoned-checkout override)', async () => {
    // valor_order_ref is set (a customer started a checkout) but the operator has
    // confirmed no payment landed. force:true bypasses the payment-in-flight 409
    // and proceeds to book.
    const { client, updatePayloads } = makeSb({ ...BASE_QUOTE, valor_order_ref: 'ord_abandoned' });
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 250, force: true }), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
    expect(json.depositUsd).toBe(250);
    expect(json.jobId).toBe(JOB_ID);
    const booking = updatePayloads[0];
    expect(booking).toMatchObject({ deposit_amount_usd: 250, status: 'booked' });
    expect(createJobFromQuote).toHaveBeenCalledOnce();
    expect(createJobFromQuote).toHaveBeenCalledWith(ID);
  });

  it('already-booked idempotency wins over force — a genuinely-paid Valor quote still returns alreadyBooked regardless of force:true', async () => {
    // deposit_paid_at set = a real payment landed. force must NOT bypass the
    // already-booked branch (it runs FIRST, before the in-flight guard).
    const { client, updatePayloads } = makeSb({
      ...BASE_QUOTE,
      deposit_paid_at: '2026-07-01T01:00:00Z',
      valor_order_ref: 'ord_paid',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 250, force: true }), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.alreadyBooked).toBe(true);
    expect(updatePayloads).toHaveLength(0); // no double-write
    expect(createJobFromQuote).toHaveBeenCalledOnce();
  });

  it('books successfully: writes deposit_paid_at, deposit_amount_usd, status=booked guarded by .is(deposit_paid_at, null), calls createJobFromQuote once', async () => {
    const { client, updatePayloads } = makeSb(BASE_QUOTE);
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.booked).toBe(true);
    expect(json.depositUsd).toBe(250);
    expect(json.jobId).toBe(JOB_ID);

    // The booking update payload must have all three fields
    const booking = updatePayloads[0];
    expect(booking).toMatchObject({ deposit_amount_usd: 250, status: 'booked' });
    expect(typeof booking.deposit_paid_at).toBe('string');

    expect(createJobFromQuote).toHaveBeenCalledOnce();
    expect(createJobFromQuote).toHaveBeenCalledWith(ID);

    // #41 referral program: this manual booking write is a third deposit-paid
    // write site (reconciled against the Valor webhook + simulate-deposit) and
    // must fire the same accrual.
    expect(accrueOnBooking).toHaveBeenCalledWith(ID);
  });

  it('still books even if the referral accrual throws (fail-open, #41)', async () => {
    const { client } = makeSb(BASE_QUOTE);
    sbRef.current = client;
    accrueOnBooking.mockRejectedValueOnce(new Error('referrals table missing'));

    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
  });

  // #41 PR 2: stamp-at-booking — every future customer gets their referral
  // link live in GHL from the moment they're manually booked.
  it('stamps the referral code for the quote\'s OWN linked customer on booking', async () => {
    const { client } = makeSb({ ...BASE_QUOTE, customer_id: 'cust-1' });
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    expect(res.status).toBe(200);
    expect(ensureReferralCode).toHaveBeenCalledWith('cust-1');
  });

  it('skips the referral code stamp when the quote has no linked customer', async () => {
    const { client } = makeSb(BASE_QUOTE);
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    expect(res.status).toBe(200);
    expect(ensureReferralCode).not.toHaveBeenCalled();
  });

  it('still books even if the referral code stamp throws (fail-open, #41 PR 2)', async () => {
    const { client } = makeSb({ ...BASE_QUOTE, customer_id: 'cust-1' });
    sbRef.current = client;
    ensureReferralCode.mockRejectedValueOnce(new Error('referrals table missing'));

    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
  });

  it('clamps depositUsd to quote.total when it exceeds it', async () => {
    const { client, updatePayloads } = makeSb({ ...BASE_QUOTE, total: 800 });
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 9999 }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.depositUsd).toBe(800);
    expect(updatePayloads[0].deposit_amount_usd).toBe(800);
  });

  // W1-043: the clamp must use the AGREED selection total, not the full
  // quote.total, so a diverged order can't over-record a deposit above what the
  // customer actually approved.
  it('clamps to the AGREED selection total when the approval snapshot diverges from quote.total', async () => {
    const { client, updatePayloads } = makeSb({
      ...BASE_QUOTE,
      total: 1000, // full quote
      result: { total: 1000 },
      approval_snapshot: { customerSelection: { currentTotalUsd: 600 } }, // customer approved $600
    });
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 800 }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    // Clamped to the agreed $600, NOT the full-quote $1000.
    expect(json.depositUsd).toBe(600);
    expect(updatePayloads[0].deposit_amount_usd).toBe(600);
  });

  it('records depositUsd as-is (unclamped) when quote.total is null (malformed/edge row)', async () => {
    const { client, updatePayloads } = makeSb({ ...BASE_QUOTE, total: null });
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 9999 }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    // No total to clamp against → the operator-entered amount is recorded as-is.
    expect(json.depositUsd).toBe(9999);
    expect(updatePayloads[0].deposit_amount_usd).toBe(9999);
  });

  it('is idempotent when the quote is already booked — returns alreadyBooked:true, no duplicate write (even with valor_order_ref set: a genuinely-paid Valor quote)', async () => {
    // A Valor-paid quote has BOTH deposit_paid_at AND valor_order_ref set. The
    // already-booked branch must win over the payment-in-flight guard, so this
    // returns alreadyBooked (not the 409 payment-in-flight).
    const { client, updatePayloads } = makeSb({
      ...BASE_QUOTE,
      deposit_paid_at: '2026-07-01T01:00:00Z',
      valor_order_ref: 'ord_paid',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.alreadyBooked).toBe(true);
    // No booking update should have been written
    expect(updatePayloads).toHaveLength(0);
    // createJobFromQuote still called (idempotent) to return the existing job
    expect(createJobFromQuote).toHaveBeenCalledOnce();
  });

  it('handles a race (update returns 0 rows) as an already-booked idempotent no-op', async () => {
    const { client } = makeSb(BASE_QUOTE, []); // [] = race loser
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.alreadyBooked).toBe(true);
    // createJobFromQuote still called — the winning concurrent request already
    // created (or is creating) the job; this call is idempotent.
    expect(createJobFromQuote).toHaveBeenCalledOnce();
  });

  it('accepts depositUsd: 0 (a fully-deferred deposit)', async () => {
    const { client } = makeSb(BASE_QUOTE);
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 0 }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.depositUsd).toBe(0);
  });
});

// GHL pipeline sync (booking bug batch 2026-07-17): a staff conversion is an
// offline close (cash/check/terminal deposit) — the same lifecycle event the
// Valor webhook already syncs to HighLevel. Diagnosed live: a real booking
// recorded through this route left the customer's pipeline card stuck in its
// entry stage because this route never touched GHL at all. These tests lock
// in the fix: the card moves to the resolved deposit-paid stage AFTER the
// booking write succeeds, non-fatally, honoring the #156 Neighbors routing.
describe('POST /api/quotes/[id]/convert-to-job — GoHighLevel pipeline sync (booking bug batch 2026-07-17)', () => {
  it('moves the card to the resolved deposit-paid stage with the AGREED total, and reports stageUpdated:true', async () => {
    const { client } = makeSb({
      ...BASE_QUOTE,
      highlevel_opportunity_id: 'opp-1',
      service_type: 'holiday',
      legacy_rebook: false,
      total: 1500,
    });
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
    expect(json.stageUpdated).toBe(true);
    expect(json.stageError).toBeUndefined();
    expect(hl.updateOpportunity).toHaveBeenCalledOnce();
    // The AGREED total (quote.total here, no snapshot) — NOT the $250 deposit.
    expect(hl.updateOpportunity).toHaveBeenCalledWith('opp-1', {
      pipelineStageId: 'stage-deposit-paid',
      monetaryValue: 1500,
    });
  });

  it('#156: a legacy rebook quote passes legacyRebook:true through to resolvePipelineStages (Neighbors routing)', async () => {
    const { client } = makeSb({
      ...BASE_QUOTE,
      highlevel_opportunity_id: 'opp-1',
      service_type: 'holiday',
      legacy_rebook: true,
    });
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    expect(res.status).toBe(200);
    expect(resolvePipelineStagesMock).toHaveBeenCalledWith('holiday', { legacyRebook: true });
  });

  it('no linked opportunity: skips the GHL move, conversion still succeeds, response carries the reason', async () => {
    const { client } = makeSb({ ...BASE_QUOTE, highlevel_opportunity_id: null });
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
    expect(json.stageUpdated).toBe(false);
    expect(json.stageError).toMatch(/no highlevel opportunity/i);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });

  it('updateOpportunity throws: conversion still succeeds (200), stageUpdated false, stageError set', async () => {
    const { client } = makeSb({ ...BASE_QUOTE, highlevel_opportunity_id: 'opp-1', service_type: 'holiday' });
    sbRef.current = client;
    hl.updateOpportunity.mockRejectedValueOnce(new Error('GHL 500'));

    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.booked).toBe(true);
    expect(json.stageUpdated).toBe(false);
    expect(json.stageError).toBe('GHL 500');
  });

  it('HighLevel not configured: skips the GHL move, conversion still succeeds', async () => {
    hl.configured.value = false;
    const { client } = makeSb({ ...BASE_QUOTE, highlevel_opportunity_id: 'opp-1' });
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stageUpdated).toBe(false);
    expect(json.stageError).toMatch(/not configured/i);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });

  // Test Quote (#93): a test quote must never touch a real GHL card, mirrored
  // defensively here even though a test quote wouldn't realistically carry a
  // real opportunity id (same defensive posture as the Valor webhook's own
  // is_test guard).
  it('test quote: never touches a real GHL card even with a linked opportunity id (#93)', async () => {
    const { client } = makeSb({ ...BASE_QUOTE, highlevel_opportunity_id: 'opp-1', is_test: true });
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.stageUpdated).toBe(false);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });

  it('does not run the GHL move on the alreadyBooked idempotent path', async () => {
    const { client } = makeSb({
      ...BASE_QUOTE,
      deposit_paid_at: '2026-07-01T01:00:00Z',
      highlevel_opportunity_id: 'opp-1',
    });
    sbRef.current = client;

    const res = await POST(makeReq({ depositUsd: 250 }), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.alreadyBooked).toBe(true);
    expect(hl.updateOpportunity).not.toHaveBeenCalled();
  });
});
