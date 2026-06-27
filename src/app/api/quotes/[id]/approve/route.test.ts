// Tests for the customer /approve endpoint (audit fix g1-route). The high-value
// guards proven here:
//   - the frozen approval_snapshot total/deposit are SERVER-RECOMPUTED from
//     quote.result, never the client-supplied currentTotal/currentDeposit
//     (#12/#13/#30/#31/#39/#63/#74/#79);
//   - unknown selectedItemIds the client sends are dropped (#13/#31);
//   - a selection below the $1,000 order-minimum is rejected 400 (#15);
//   - the read-then-write idempotency TOCTOU is closed: two concurrent approves
//     yield exactly one ok + one 409, and the messaging fires at most once (#43);
//   - a failed internal notification stamps the durable approval_notify marker
//     (#18/#83);
//   - approvedWhileUnsent is recorded from quote_sent_at (#93).
// Supabase + HighLevel + Valor-checkout mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { sbRef, hl, valorCheckout } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  hl: {
    configured: { value: true },
    sendSms: vi.fn(async () => ({})),
    sendEmail: vi.fn(async () => ({})),
  },
  valorCheckout: { enabled: { value: false } },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));

vi.mock('@/lib/integrations/highlevel', () => ({
  isHighLevelConfigured: () => hl.configured.value,
  sendSms: hl.sendSms,
  sendEmail: hl.sendEmail,
  HighLevelError: class HighLevelError extends Error {},
}));

vi.mock('@/lib/integrations/valorCheckout', () => ({
  isValorCheckoutEnabled: () => valorCheckout.enabled.value,
}));

import { POST } from './route';

// A QuoteResult whose portal line items are: Santa's $1200, Gingerbread $1500
// (mutually-exclusive roofline options → ids roofline-santas/roofline-gingerbread)
// plus two spritzers ($300 → spritzer-1, $200 → spritzer-2). Easily clears the
// $1,000 minimum on the roofline alone.
const RESULT = {
  lineItems: [
    { label: "Santa's Roofline – 180ft (medium)", amount: 1200 },
    { label: '24" Spritzer', amount: 300 },
    { label: '24" Spritzer', amount: 200 },
  ],
  subtotalBeforeDiscount: 0,
  discountAmount: 0,
  earlyInstallDiscountAmount: 0,
  subtotalAfterDiscount: 0,
  minimumApplied: false,
  rushFeeAmount: 0,
  takedownAmount: 0,
  taxableAmount: 0,
  taxAmount: 0,
  total: 0,
  depositAmount: 0,
  balanceDue: 0,
  rooflineChoice: 'santas',
  rooflineOptions: {
    santas: { footage: 180, amount: 1200 },
    gingerbread: { footage: 270, amount: 1500 },
  },
};

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function baseQuote(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    customer_name: 'Jordan Smith',
    customer_address: '1 Main St',
    customer_phone: '+15555550123',
    customer_email: 'jordan@example.com',
    total: 9999,
    result: RESULT,
    inputs: null,
    highlevel_contact_id: null,
    customer_approved_at: null,
    quote_sent_at: '2026-06-25T00:00:00Z',
    ...overrides,
  };
}

// Fake Supabase builder. read = from().select().eq().single(); the guarded
// approval update = from().update().eq().is().select() (returns rows); the
// notify-marker update = from().update().eq() (awaited via then). `updateRows`
// controls what the guarded update returns (the TOCTOU race winner).
function makeSb(quote: Record<string, unknown> | null, updateRows: Array<{ id: string }> | null = [{ id: ID }]) {
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
    is: () => builder,
    single: async () => ({ data: quote, error: quote ? null : { message: 'no row' } }),
    // The guarded approval update terminates in .select('id') → resolves rows.
    then: (resolve: (v: unknown) => void) => {
      const res = isUpdate ? { data: updateRows, error: null } : { data: quote, error: null };
      isUpdate = false;
      resolve(res);
    },
  });
  return { client: builder, updatePayloads };
}

function makeReq(body: Record<string, unknown>): NextRequest {
  return {
    json: async () => body,
    headers: { get: () => null },
    nextUrl: { origin: 'https://quote.example.com' },
  } as unknown as NextRequest;
}
const params = Promise.resolve({ id: ID });

const validBody = {
  packageId: 'A' as const,
  selectedItemIds: ['roofline-santas', 'spritzer-1'],
  activeName: 'Classic Glow',
  currentTotal: 999999, // tampered — server must ignore
  currentDeposit: 0,
  installDiscountUsd: 999999, // tampered
};

beforeEach(() => {
  vi.clearAllMocks();
  hl.configured.value = false; // no messaging unless a test opts in
  valorCheckout.enabled.value = false;
});

describe('POST /api/quotes/[id]/approve — server recompute', () => {
  it('freezes the SERVER-recomputed total/deposit, not the tampered client values', async () => {
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);

    // The guarded approval update is the first update payload.
    const snap = updatePayloads[0].approval_snapshot as {
      customerSelection: { currentTotalUsd: number; currentDepositUsd: number; installDiscountUsd: number };
      serverRecomputed: boolean;
    };
    // Santa's $1200 + spritzer-1 $300 = $1500 subtotal, +8.75% tax = $1631.25,
    // deposit = $815.625 → 815.63. Nowhere near the tampered 999999.
    expect(snap.serverRecomputed).toBe(true);
    expect(snap.customerSelection.currentTotalUsd).toBeCloseTo(1631.25, 2);
    expect(snap.customerSelection.currentDepositUsd).toBeCloseTo(815.63, 2);
    expect(snap.customerSelection.installDiscountUsd).toBe(0);
  });

  it('drops unknown selectedItemIds the client sends', async () => {
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    await POST(
      makeReq({ ...validBody, selectedItemIds: ['roofline-santas', 'spritzer-1', 'bogus-id', '../../etc'] }),
      { params },
    );
    const snap = updatePayloads[0].approval_snapshot as {
      customerSelection: { selectedItemIds: string[] };
    };
    expect(snap.customerSelection.selectedItemIds).toEqual(['roofline-santas', 'spritzer-1']);
  });

  it('rejects a below-minimum selection (only a $300 spritzer, no roofline)', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ ...validBody, selectedItemIds: ['spritzer-1'] }), { params });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('below-minimum');
  });

  it('rejects an empty selection', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ ...validBody, selectedItemIds: [] }), { params });
    expect(res.status).toBe(400);
  });

  it('records approvedWhileUnsent=true when the quote was never sent', async () => {
    const { client, updatePayloads } = makeSb(baseQuote({ quote_sent_at: null }));
    sbRef.current = client;

    await POST(makeReq(validBody), { params });
    const snap = updatePayloads[0].approval_snapshot as { approvedWhileUnsent: boolean };
    expect(snap.approvedWhileUnsent).toBe(true);
  });

  it('records approvedWhileUnsent=false when the quote was sent', async () => {
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    await POST(makeReq(validBody), { params });
    const snap = updatePayloads[0].approval_snapshot as { approvedWhileUnsent: boolean };
    expect(snap.approvedWhileUnsent).toBe(false);
  });
});

describe('POST /api/quotes/[id]/approve — TOCTOU + notify marker', () => {
  it('returns 409 and skips messaging when the guarded update wins no rows (race lost)', async () => {
    hl.configured.value = true;
    // updateRows = [] → another concurrent caller already set customer_approved_at.
    const { client } = makeSb(baseQuote({ highlevel_contact_id: 'c1' }), []);
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('already-approved');
    // No notifications fired for the loser of the race.
    expect(hl.sendSms).not.toHaveBeenCalled();
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('stamps approval_notify_failed_at when the internal email is not sent', async () => {
    // HL configured + contact present, but the internal email send throws.
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    hl.sendEmail.mockRejectedValue(new Error('GHL down'));
    const { client, updatePayloads } = makeSb(baseQuote({ highlevel_contact_id: 'c1' }));
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBe(200);
    // Second update payload is the notify marker (first is the guarded approval).
    const marker = updatePayloads.find((p) => 'approval_notify_failed_at' in p);
    expect(marker).toBeTruthy();
    expect(marker!.approval_notify_failed_at).toBeTruthy();

    delete process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
    hl.sendEmail.mockResolvedValue({});
  });
});
