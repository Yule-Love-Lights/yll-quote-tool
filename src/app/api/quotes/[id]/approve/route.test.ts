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

// #101: the route reads the live swatch list via getAppSettings to validate +
// freeze the color choice. Stub it to the factory defaults (built-in swatches) so
// these approval tests don't route an app_settings query through the quote mock.
vi.mock('@/lib/appSettings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/appSettings')>('@/lib/appSettings');
  return { ...actual, getAppSettings: async () => actual.DEFAULT_APP_SETTINGS };
});

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
    status: null,         // null = legacy/no explicit status; deriveStatus falls through to timestamps
    deposit_paid_at: null,
    viewed_at: null,
    quote_sent_at: '2026-06-25T00:00:00Z',
    ...overrides,
  };
}

// Fake Supabase builder. read = from().select().eq().single(); the guarded
// approval update = from().update().eq().is().<terminal-status filter>.select()
// (returns rows); the notify-marker update = from().update().eq() (awaited via
// then). `updateRows` controls what the guarded update returns (the TOCTOU race
// winner).
//
// W1-014: the mock models the terminal-status filter's Postgres NULL semantics so
// a NULL-status row correctly reproduces the three-valued-logic bug —
// `.not('status','in',(…))` EXCLUDES a NULL-status row (NOT (NULL IN (…)) = NULL =
// not-matched), whereas the fixed `.or('status.not.in.(…),status.is.null')`
// admits it. When the filter excludes the row, the guarded update matches 0 rows
// regardless of `updateRows`.
const TERMINAL_SET = new Set(['declined', 'cancelled', 'lost']);
function makeSb(quote: Record<string, unknown> | null, updateRows: Array<{ id: string }> | null = [{ id: ID }]) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  const builder: Record<string, unknown> = {};
  let isUpdate = false;
  // null = no terminal-status filter seen yet; true/false = does the row pass it.
  let terminalFilterPasses: boolean | null = null;
  const status = quote ? (quote.status as string | null | undefined) ?? null : null;
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
    // Buggy form: `.not('status','in','("declined","cancelled","lost")')`.
    // Postgres: NOT (status IN (…)) is NULL (→ excluded) when status IS NULL.
    not: (col: string, op: string) => {
      if (col === 'status' && op === 'in') {
        terminalFilterPasses = status === null ? false : !TERMINAL_SET.has(status);
      }
      return builder;
    },
    // Fixed form: `.or('status.not.in.(…),status.is.null')` — admits NULL.
    or: (filter: string) => {
      if (filter.includes('status')) {
        const notInTerminal = status !== null && !TERMINAL_SET.has(status);
        const isNull = filter.includes('status.is.null') && status === null;
        terminalFilterPasses = notInTerminal || isNull;
      }
      return builder;
    },
    single: async () => ({ data: quote, error: quote ? null : { message: 'no row' } }),
    // The guarded approval update terminates in .select('id') → resolves rows.
    then: (resolve: (v: unknown) => void) => {
      const excluded = isUpdate && terminalFilterPasses === false;
      const res = isUpdate
        ? { data: excluded ? [] : updateRows, error: null }
        : { data: quote, error: null };
      isUpdate = false;
      terminalFilterPasses = null;
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

  it('zeroes the snapshot installDiscountUsd when a staff manual discount wins (W4-017)', async () => {
    // Manual discount present (inputs.discount) AND the customer also sent an
    // early-install installTiming. Manual wins on price (discountRate/discountFlat
    // come from `d`, not installDiscountRate) — so the snapshot's installDiscountUsd
    // must be 0, matching what was actually billed, not a phantom early-install amount.
    const { client, updatePayloads } = makeSb(
      baseQuote({ inputs: { discount: { type: 'percentage', amount: 0.1 } } }),
    );
    sbRef.current = client;

    const res = await POST(
      makeReq({ ...validBody, installTiming: 'october' }),
      { params },
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    const snap = updatePayloads[0].approval_snapshot as {
      customerSelection: { installDiscountUsd: number };
    };
    expect(snap.customerSelection.installDiscountUsd).toBe(0);
  });

  it('still records the early-install discount when there is no manual discount', async () => {
    // Sanity check for the fix above: no manual discount → installTiming alone
    // still produces a non-zero snapshot amount (existing behavior unchanged).
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(
      makeReq({ ...validBody, installTiming: 'october' }),
      { params },
    );
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as {
      customerSelection: { installDiscountUsd: number };
    };
    expect(snap.customerSelection.installDiscountUsd).toBeGreaterThan(0);
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

describe('POST /api/quotes/[id]/approve — e-signature capture (#83 Slice B)', () => {
  it('captures a typed signature into the snapshot', async () => {
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(
      makeReq({ ...validBody, signature: { name: 'Jordan Smith', kind: 'typed', value: 'Jordan Smith' } }),
      { params },
    );
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as {
      signature: { name: string; kind: string; value: string; signed_at: string; ip: string | null } | null;
    };
    expect(snap.signature).toBeTruthy();
    expect(snap.signature!.name).toBe('Jordan Smith');
    expect(snap.signature!.kind).toBe('typed');
    expect(snap.signature!.value).toBe('Jordan Smith');
    expect(typeof snap.signature!.signed_at).toBe('string');
    // ip is captured from the request header (null when absent, as in this mock)
    expect('ip' in snap.signature!).toBe(true);
  });

  it('captures a drawn signature (data-URL value)', async () => {
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const res = await POST(
      makeReq({ ...validBody, signature: { name: 'Jordan Smith', kind: 'drawn', value: dataUrl } }),
      { params },
    );
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as { signature: { kind: string; value: string } | null };
    expect(snap.signature!.kind).toBe('drawn');
    expect(snap.signature!.value).toBe(dataUrl);
  });

  it('is backward-compatible — no signature field ⇒ signature: null, still 200', async () => {
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as { signature: unknown };
    expect(snap.signature).toBeNull();
  });

  it('rejects a malformed signature (missing name) → 400', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(
      makeReq({ ...validBody, signature: { kind: 'typed', value: 'x' } }),
      { params },
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('bad-signature');
  });

  it('rejects a signature with an unknown kind → 400', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(
      makeReq({ ...validBody, signature: { name: 'J', kind: 'wet-ink', value: 'x' } }),
      { params },
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/quotes/[id]/approve — status gate (Bug 2)', () => {
  it('rejects a declined quote with 409 (no write, no booking)', async () => {
    // declined: customer_approved_at NULL (decline leaves it null), status='declined'
    const { client, updatePayloads } = makeSb(
      baseQuote({ status: 'declined', deposit_paid_at: null }),
    );
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('illegal-transition');
    // No snapshot write must happen
    expect(updatePayloads.some((p) => 'customer_approved_at' in p)).toBe(false);
  });

  it('rejects a cancelled quote with 409', async () => {
    const { client, updatePayloads } = makeSb(
      baseQuote({ status: 'cancelled', deposit_paid_at: null }),
    );
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('illegal-transition');
    expect(updatePayloads.some((p) => 'customer_approved_at' in p)).toBe(false);
  });

  it('rejects a lost quote with 409', async () => {
    const { client, updatePayloads } = makeSb(
      baseQuote({ status: 'lost', deposit_paid_at: null }),
    );
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('illegal-transition');
    expect(updatePayloads.some((p) => 'customer_approved_at' in p)).toBe(false);
  });

  it('allows a normal sent/viewed quote to approve (existing happy path unbroken)', async () => {
    // sent quote: status null (legacy) + quote_sent_at set
    const { client } = makeSb(
      baseQuote({ status: null, deposit_paid_at: null }),
    );
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  // W1-014: a legacy/NULL-status row must be approvable. The buggy
  // `.not('status','in',(…))` filter EXCLUDES a NULL-status row (Postgres
  // three-valued logic: NOT (NULL IN (…)) = NULL → not-matched), so the guarded
  // update matched 0 rows and the customer got a false 409 while nothing was
  // recorded. The fix uses the OR-with-null idiom (mirroring the decline route),
  // so the NULL-status row is admitted and the approval is written.
  it('approves a legacy NULL-status quote (does not false-409 on NULL status)', async () => {
    const { client, updatePayloads } = makeSb(
      baseQuote({ status: null, deposit_paid_at: null, quote_sent_at: '2026-06-25T00:00:00Z' }),
    );
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    // The guarded approval write actually landed (snapshot + approval stamp).
    expect(updatePayloads.some((p) => 'customer_approved_at' in p)).toBe(true);
  });

  it('allows a changes_requested quote to approve', async () => {
    const { client } = makeSb(
      baseQuote({ status: 'changes_requested', deposit_paid_at: null }),
    );
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    // changes_requested → approved is NOT in the transition table, so this is 409
    // (customer should wait for the resend; they can't self-approve a quote under revision)
    // Actually check the transition table: changes_requested → ['sent','declined','cancelled','lost']
    // 'approved' is NOT in that list, so this should be rejected too.
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('illegal-transition');
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
