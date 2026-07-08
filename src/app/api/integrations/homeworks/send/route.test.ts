// Unit test for the home.works /send route — money + double-send fixes.
//
// (a) HIGH money fix: this route RESENDS an already-approved quote, but a
//     customer approves a SELECTION on the portal (deselecting items, picking
//     the cheaper roofline tier, toggling rush/takedown). Billing off the
//     full engine-priced result on a resend asks home.works for MORE than the
//     customer agreed to. Locks in that both the flat totalUsd AND
//     homeworksLineItem.totalUsd (the figure home.works actually bills off
//     of — see the Zap field-mapping comment in lib/integrations/types.ts)
//     reflect the AGREED total via resolveAgreedTotal, not r.total.
// (b) MEDIUM double-send fix: two concurrent POSTs for the same quote must
//     fire Zapier exactly once — the loser of the atomic pre-claim race gets
//     a 409 instead of double-sending a real estimate (mirrors /signed's
//     atomic idempotency guard, adapted to claim BEFORE the external call
//     since /send — unlike /signed — is the one that CREATES the side effect).
//
// Supabase is a fake in-memory builder; sendQuoteToHomeworks is mocked (no
// network). buildHomeworksSingleLineItem is the REAL implementation so the
// test proves the actual dollar figure home.works receives.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// ── Mocks (hoisted so the vi.mock factories can see them) ───────────────────
const { sbRef, sendQuoteToHomeworksMock, requireOperatorMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  sendQuoteToHomeworksMock: vi.fn(async (_payload: unknown) => ({
    ok: true,
    statusCode: 200,
    webhookResponse: { received: true },
  })),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  // Each call returns a FRESH builder (a new client per request) so two
  // concurrent POSTs don't share mutable chain state — the only shared state
  // is the `claimed` flag captured by makeSb, modeling the single DB row.
  getSupabaseServiceClient: () => (sbRef.current as () => unknown)(),
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimitResponse: () => null,
}));

// Keep the REAL buildHomeworksSingleLineItem (pure, no side effects) so the
// test proves the actual dollar figure that reaches home.works; only stub the
// network call.
vi.mock('@/lib/integrations/homeworks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/integrations/homeworks')>();
  return { ...actual, sendQuoteToHomeworks: sendQuoteToHomeworksMock };
});

import { POST } from './route';

// ── Fake Supabase query builder ─────────────────────────────────────────────
// Handles the chains this route uses on ONE client per request:
//   read:               from().select().eq().single()               -> quote
//   atomic claim:        from().update().eq().(eq|is)().select('id') -> claim rows
//   finalize/rollback:  from().update().eq()                         -> plain ack
// `claimed` is shared ACROSS request-scoped builders (closure) so concurrent
// requests race on the SAME simulated row — only the first claim wins.
type Quote = Record<string, unknown> | null;
function makeSb(quote: Quote) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  let claimed = false;

  function newClient() {
    const builder: Record<string, unknown> = {};
    let isUpdate = false;
    let hasSelect = false;
    Object.assign(builder, {
      from: () => builder,
      select: () => {
        if (isUpdate) hasSelect = true;
        return builder;
      },
      update: (payload: Record<string, unknown>) => {
        isUpdate = true;
        hasSelect = false;
        updatePayloads.push(payload);
        return builder;
      },
      eq: () => builder,
      is: () => builder,
      single: async () => ({ data: quote, error: quote ? null : { message: 'no row' } }),
      then: (resolve: (v: unknown) => void) => {
        if (isUpdate && hasSelect) {
          const rows = claimed ? [] : [{ id: (quote as { id?: string })?.id ?? 'q1' }];
          claimed = true;
          isUpdate = false;
          hasSelect = false;
          resolve({ data: rows, error: null });
        } else if (isUpdate) {
          isUpdate = false;
          resolve({ data: null, error: null });
        } else {
          resolve({ data: quote, error: null });
        }
      },
    });
    return builder;
  }

  return { factory: newClient, updatePayloads };
}

const QUOTE_ID = '11111111-1111-4111-8111-111111111111';

// Full engine-priced result: $6480 total ($6000 subtotal + $480 tax @ 8%).
const FULL_RESULT = {
  lineItems: [{ id: 'a', label: 'Roofline', price: 6000, amount: 6000 }],
  subtotalBeforeDiscount: 6000,
  discountAmount: 0,
  subtotalAfterDiscount: 6000,
  rushFeeAmount: 0,
  takedownAmount: 0,
  taxableAmount: 6000,
  taxAmount: 480,
  total: 6480,
  depositAmount: 3240,
  balanceDue: 3240,
  minimumApplied: false,
};

function makeReq(body: Record<string, unknown>): NextRequest {
  return {
    json: async () => body,
    url: 'https://quote.example.com/api/integrations/homeworks/send',
  } as unknown as NextRequest;
}

function baseQuote(overrides: Record<string, unknown>) {
  return {
    id: QUOTE_ID,
    customer_name: 'Jordan Smith',
    customer_address: '123 Main St',
    customer_phone: '5551234567',
    customer_email: 'jordan@example.com',
    total: 6480,
    result: FULL_RESULT,
    highlevel_contact_id: null,
    homeworks_sent_at: null,
    customer_approved_at: null,
    approval_snapshot: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  process.env.HOMEWORKS_ZAPIER_WEBHOOK_URL = 'https://hooks.zapier.com/hooks/catch/test';
});

describe('home.works /send — HIGH: bills the AGREED total on a resend', () => {
  it('a partial-approval resend bills the agreed total, not the full engine total', async () => {
    // Customer approved a $4860 selection (75%) of the $6480 full-engine
    // quote — e.g. deselected an item or picked the cheaper roofline tier.
    const QUOTE = baseQuote({
      customer_approved_at: '2026-01-01T00:00:00.000Z',
      approval_snapshot: {
        customerSelection: { activeName: 'Build Your Own', currentTotalUsd: 4860 },
      },
    });
    const { factory } = makeSb(QUOTE);
    sbRef.current = factory;

    const res = await POST(makeReq({ quoteId: QUOTE_ID }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(sendQuoteToHomeworksMock).toHaveBeenCalledTimes(1);
    const payload = sendQuoteToHomeworksMock.mock.calls[0]![0] as Record<string, unknown>;

    // The flat total must be the AGREED total, never the full engine total.
    expect(payload.totalUsd).toBe(4860);
    expect(payload.totalUsd).not.toBe(6480);

    // The figure home.works ACTUALLY bills off of (Total/Price maps to
    // homeworksLineItem.totalUsd) must scale to the same agreed basis — this
    // is the real money bug: billing the customer's supplier for more than
    // they approved.
    const homeworksLineItem = payload.homeworksLineItem as { totalUsd: number };
    expect(homeworksLineItem.totalUsd).toBe(4500); // 6000 * (4860 / 6480)
    expect(homeworksLineItem.totalUsd).not.toBe(6000);

    // Tax scales proportionally too (mirrors invoices.ts's scaledTax formula).
    expect(payload.taxAmountUsd).toBe(360); // 480 * 0.75
  });

  it('an un-approved quote (no snapshot) still bills the full engine total unchanged', async () => {
    const QUOTE = baseQuote({});
    const { factory } = makeSb(QUOTE);
    sbRef.current = factory;

    const res = await POST(makeReq({ quoteId: QUOTE_ID }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const payload = sendQuoteToHomeworksMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.totalUsd).toBe(6480);
    expect((payload.homeworksLineItem as { totalUsd: number }).totalUsd).toBe(6000);
  });
});

describe('home.works /send — MEDIUM: atomic claim prevents a double-send', () => {
  it('two concurrent sends for the same quote fire Zapier exactly once', async () => {
    const QUOTE = baseQuote({});
    const { factory } = makeSb(QUOTE);
    sbRef.current = factory;

    const [r1, r2] = await Promise.all([
      POST(makeReq({ quoteId: QUOTE_ID })),
      POST(makeReq({ quoteId: QUOTE_ID })),
    ]);
    const [j1, j2] = await Promise.all([r1.json(), r2.json()]);

    expect(sendQuoteToHomeworksMock).toHaveBeenCalledTimes(1);
    const oks = [j1, j2].filter(j => j.ok === true);
    const conflicts = [r1.status, r2.status].filter(s => s === 409);
    expect(oks).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
  });
});
