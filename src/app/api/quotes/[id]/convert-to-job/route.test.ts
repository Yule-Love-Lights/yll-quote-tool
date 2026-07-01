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

const { createJobFromQuote, requireOperatorMock, sbRef } = vi.hoisted(() => ({
  createJobFromQuote: vi.fn(),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  sbRef: { current: null as unknown },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/jobs', () => ({ createJobFromQuote }));

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
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  createJobFromQuote.mockResolvedValue({ id: JOB_ID, status: 'to_schedule' });
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
