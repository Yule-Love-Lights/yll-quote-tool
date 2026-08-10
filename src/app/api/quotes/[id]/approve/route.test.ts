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
// Wrapped in vi.fn() (not a bare async fn) so individual tests (e.g. the
// hideEarlyInstallDiscounts enforcement test below) can override the resolved
// value for one call via mockResolvedValueOnce.
vi.mock('@/lib/appSettings', async () => {
  const actual = await vi.importActual<typeof import('@/lib/appSettings')>('@/lib/appSettings');
  return { ...actual, getAppSettings: vi.fn(async () => actual.DEFAULT_APP_SETTINGS) };
});

import { POST } from './route';
import { getAppSettings, DEFAULT_APP_SETTINGS } from '@/lib/appSettings';

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

// A PERMANENT QuoteResult (#88): front $4000 + back $2100 (stable ids). Whole
// quote $6100 clears the $2,500 gate, so a back-only ($2100) selection is below
// it — proving the gate uses the frozen snapshot minimum, not the holiday $1,000.
const PERM_RESULT = {
  ...RESULT,
  lineItems: [
    { label: 'Permanent Lighting - Front - 100 ft ($40/ft)', amount: 4000, id: 'permanent-front' },
    { label: 'Permanent Lighting - Back - 60 ft ($35/ft)', amount: 2100, id: 'permanent-back' },
  ],
  rooflineChoice: 'none',
  rooflineOptions: { santas: null, gingerbread: null },
  permanentRatesSnapshot: { frontPerFt: 40, sidesPerFt: 35, backPerFt: 35, minimumJobAmount: 2500, maintenancePrice: 0 },
};

// A PERMANENT BISTRO QuoteResult: a $700 run + a $200 poles line (stable ids,
// mirroring calculatePermanentBistro's own id shapes). $700 is ABOVE the
// bistro rate's own $500 gate but BELOW the holiday $1,000 default — the
// exact value that distinguishes the fixed gate (reads the bistro snapshot)
// from the pre-fix bug (silently fell back to the $1,000 holiday default).
const BISTRO_RESULT = {
  ...RESULT,
  lineItems: [
    { label: 'Permanent Bistro Lighting – 23ft', amount: 700, id: 'permanent-bistro-0' },
    { label: 'Poles (2)', amount: 200, id: 'permanent-bistro-poles' },
  ],
  rooflineChoice: 'none',
  rooflineOptions: { santas: null, gingerbread: null },
  permanentBistroRatesSnapshot: { perFt: 30, perPole: 100, minimum: 500 },
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
    view_only: false,
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
  signature: { name: 'Jordan Smith', kind: 'typed' as const, value: 'Jordan Smith' },
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

  // #177 fix 2 — the snapshot must freeze the EFFECTIVE deposit rate at
  // approval time so post-approval surfaces (the approved page, the sticky
  // bar's pending-payment state, the valor webhook's internal alert) can read
  // the FROZEN percent instead of a live one that could drift later.
  it('freezes the effective deposit rate (a staff override) into the snapshot', async () => {
    const { client, updatePayloads } = makeSb(baseQuote({ inputs: { depositPercent: 25 } }));
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as {
      customerSelection: { depositRate: number };
    };
    expect(snap.customerSelection.depositRate).toBe(0.25);
  });

  it('freezes the default 50% deposit rate when inputs.depositPercent is absent', async () => {
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as {
      customerSelection: { depositRate: number };
    };
    expect(snap.customerSelection.depositRate).toBe(0.5);
  });

  // #199 F1 (wrap-review HIGH): inputs.depositPercent and result.depositRate
  // are independently-writable — a tag write (the NCE admin toggle) or a
  // rebook clone patches ONLY inputs.depositPercent, never result. Before this
  // fix, currentDepositUsd derived from chargesFromResult(quote.result) alone
  // (the STALE result.depositRate), while the snapshot's OWN depositRate field
  // was a separate live effectiveDepositRate(inputs.depositPercent) call — the
  // frozen record said "40%" but charged 50%'s worth of dollars. Proves both
  // fields now agree, sourced from the SAME resolved rate, even with a result
  // that was priced BEFORE the tag/percent changed.
  it('freezes a 40%-CONSISTENT rate + dollar amount when inputs.depositPercent disagrees with a STALE result.depositRate (#199 F1)', async () => {
    const { client, updatePayloads } = makeSb(
      baseQuote({
        inputs: { depositPercent: 40 },
        // Simulates a quote priced BEFORE the NCE tag/depositPercent write —
        // the admin NCE toggle route and rebook.ts patch ONLY inputs, never
        // result, so this stays stuck at the OLD 50% forever without this fix.
        result: { ...RESULT, depositRate: 0.5 },
      }),
    );
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as {
      customerSelection: { currentTotalUsd: number; currentDepositUsd: number; depositRate: number };
    };
    // Santa's $1200 + spritzer-1 $300 = $1500 subtotal, +8.75% tax = $1631.25.
    expect(snap.customerSelection.currentTotalUsd).toBeCloseTo(1631.25, 2);
    expect(snap.customerSelection.depositRate).toBe(0.4);
    // 1631.25 * 0.40 = 652.50 — NOT the stale-rate 815.63 (50%).
    expect(snap.customerSelection.currentDepositUsd).toBeCloseTo(652.5, 2);
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

// W1-013: the manual-discount, waive-minimum, early-install, and rush/takedown
// branches that shape the FROZEN approval snapshot total/deposit had zero
// money-assertion coverage — every existing test above passes inputs:null and
// leaves installTiming/rushSelected/takedownSelected unset. These lock the
// route's mapping from quote.inputs into priceSelection/effectiveCharges
// against real numbers (charter §6 — money paths must be TDD'd), on the same
// roofline-santas $1200 + spritzer-1 $300 = $1500 subtotal the recompute tests
// above already establish.
describe('POST /api/quotes/[id]/approve — discount/waiver/timing/fee branches (W1-013)', () => {
  it('a manual PERCENTAGE discount (0.2 = 20%) is applied as a fraction, not a whole percent', async () => {
    const { client, updatePayloads } = makeSb(
      baseQuote({ inputs: { discount: { type: 'percentage', amount: 0.2 } } }),
    );
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as {
      customerSelection: { currentTotalUsd: number; currentDepositUsd: number };
    };
    // $1500 subtotal - 20% ($300) = $1200 taxable, +8.75% tax ($105) = $1305,
    // deposit = $652.50. A whole-percent bug (15 instead of 0.15-style) would
    // either produce a wildly different total or 0 selected out entirely.
    expect(snap.customerSelection.currentTotalUsd).toBeCloseTo(1305, 2);
    expect(snap.customerSelection.currentDepositUsd).toBeCloseTo(652.5, 2);
  });

  it('a manual FLAT discount ($150) is subtracted as dollars, not treated as a rate', async () => {
    const { client, updatePayloads } = makeSb(
      baseQuote({ inputs: { discount: { type: 'flat', amount: 150 } } }),
    );
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as {
      customerSelection: { currentTotalUsd: number; currentDepositUsd: number };
    };
    // $1500 - $150 flat = $1350 taxable, +8.75% tax ($118.125 exact,
    // rounded half-up to $118.13) = $1468.13, deposit = $734.07.
    expect(snap.customerSelection.currentTotalUsd).toBeCloseTo(1468.13, 2);
    expect(snap.customerSelection.currentDepositUsd).toBeCloseTo(734.07, 2);
  });

  it('waiveMinimum:true approves a sub-$1,000 selection that would otherwise 400', async () => {
    // Sanity check first: WITHOUT the waiver, a $300 spritzer-only selection is
    // rejected below-minimum (mirrors the existing "rejects a below-minimum" test).
    const { client: unwaived } = makeSb(baseQuote());
    sbRef.current = unwaived;
    const rejected = await POST(makeReq({ ...validBody, selectedItemIds: ['spritzer-1'] }), { params });
    expect(rejected.status).toBe(400);

    // WITH inputs.waiveMinimum, the identical selection is approved and priced
    // for real (not zeroed) — $300 taxable, +8.75% tax ($26.25) = $326.25,
    // deposit = $163.13.
    const { client: waived, updatePayloads } = makeSb(
      baseQuote({ inputs: { waiveMinimum: true } }),
    );
    sbRef.current = waived;
    const res = await POST(makeReq({ ...validBody, selectedItemIds: ['spritzer-1'] }), { params });
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as {
      customerSelection: { currentTotalUsd: number; currentDepositUsd: number };
    };
    expect(snap.customerSelection.currentTotalUsd).toBeCloseTo(326.25, 2);
    expect(snap.customerSelection.currentDepositUsd).toBeCloseTo(163.13, 2);
  });

  it('installTiming:"september" freezes the SERVER-derived snapshotInstallDiscountUsd (15%)', async () => {
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ ...validBody, installTiming: 'september' }), { params });
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as {
      customerSelection: { installTiming: string; installDiscountUsd: number; currentTotalUsd: number };
    };
    // $1500 * 15% = $225 discount → $1275 taxable, +8.75% tax ($111.56) = $1386.56.
    expect(snap.customerSelection.installTiming).toBe('september');
    expect(snap.customerSelection.installDiscountUsd).toBeCloseTo(225, 2);
    expect(snap.customerSelection.currentTotalUsd).toBeCloseTo(1386.56, 2);
  });

  it('forces the early-install discount OFF server-side when portal.hideEarlyInstallDiscounts is on, even if installTiming=september is forged', async () => {
    // Audit fix (approve-discount-enforce): staff turned the "hide early-install
    // discounts" portal setting on (Settings → Customer Portal). A forged/
    // stale-tab POST with installTiming:'september' must NOT still earn the
    // 15% discount in the frozen snapshot — the server must force installTiming
    // to 'none' regardless of what the client sent.
    vi.mocked(getAppSettings).mockResolvedValueOnce({
      ...DEFAULT_APP_SETTINGS,
      portal: { hideEarlyInstallDiscounts: true },
    });
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ ...validBody, installTiming: 'september' }), { params });
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as {
      customerSelection: { installTiming: string; installDiscountUsd: number; currentTotalUsd: number };
    };
    // No discount at all → $1500 taxable, +8.75% tax = $1631.25 (same subtotal as
    // the base recompute test, which has no install timing).
    expect(snap.customerSelection.installTiming).toBe('none');
    expect(snap.customerSelection.installDiscountUsd).toBe(0);
    expect(snap.customerSelection.currentTotalUsd).toBeCloseTo(1631.25, 2);
  });

  it('rushSelected + takedownSelected land their fees in the recomputed total', async () => {
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(
      makeReq({ ...validBody, rushSelected: true, takedownSelected: true }),
      { params },
    );
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as {
      customerSelection: { rushSelected: boolean; takedownSelected: boolean; currentTotalUsd: number; currentDepositUsd: number };
    };
    // $1500 + $150 rush + $150 takedown = $1800 taxable, +8.75% tax ($157.50)
    // = $1957.50, deposit = $978.75.
    expect(snap.customerSelection.rushSelected).toBe(true);
    expect(snap.customerSelection.takedownSelected).toBe(true);
    expect(snap.customerSelection.currentTotalUsd).toBeCloseTo(1957.5, 2);
    expect(snap.customerSelection.currentDepositUsd).toBeCloseTo(978.75, 2);
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

  it('rejects an oversized signature value before any approval write (snapshot is CAS-matched by serialized size)', async () => {
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(
      makeReq({
        ...validBody,
        signature: { name: 'Jordan Smith', kind: 'drawn', value: `data:image/png;base64,${'A'.repeat(2_000)}` },
      }),
      { params },
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('bad-signature');
    expect(updatePayloads).toHaveLength(0);
  });

  it('rejects a missing signature before any approval write', async () => {
    const { signature: _signature, ...bodyWithoutSignature } = validBody;
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(bodyWithoutSignature), { params });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('bad-signature');
    expect(updatePayloads).toHaveLength(0);
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

  // PS-D6: a single character was accepted as a legal e-signature.
  it('rejects a single-character signature name → 400 bad-signature', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(
      makeReq({ ...validBody, signature: { name: 'J', kind: 'typed', value: 'J' } }),
      { params },
    );
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('bad-signature');
  });

  it('accepts a two-character signature name (the minimum)', async () => {
    const { client, updatePayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(
      makeReq({ ...validBody, signature: { name: 'Jo', kind: 'typed', value: 'Jo' } }),
      { params },
    );
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as { signature: { name: string } | null };
    expect(snap.signature!.name).toBe('Jo');
  });
});

describe('POST /api/quotes/[id]/approve — view-only portal (#176)', () => {
  it('409s a view-only quote (no write, no booking)', async () => {
    const { client, updatePayloads } = makeSb(baseQuote({ view_only: true }));
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.code).toBe('view-only');
    expect(updatePayloads.some((p) => 'customer_approved_at' in p)).toBe(false);
  });

  it('allows a normal (non-view-only) quote to approve — unaffected', async () => {
    const { client } = makeSb(baseQuote({ view_only: false }));
    sbRef.current = client;

    const res = await POST(makeReq(validBody), { params });
    expect(res.status).toBe(200);
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

describe('POST /api/quotes/[id]/approve — permanent (#88 P6)', () => {
  it('forces holiday fees OFF even if the body toggles rush/takedown/early-install', async () => {
    const { client, updatePayloads } = makeSb(
      baseQuote({ result: PERM_RESULT, service_type: 'permanent' }),
    );
    sbRef.current = client;
    const res = await POST(
      makeReq({
        ...validBody,
        selectedItemIds: ['permanent-front'], // $4000
        rushSelected: true,
        takedownSelected: true,
        installTiming: 'september',
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as {
      customerSelection: { currentTotalUsd: number };
      serverRecomputed: boolean;
    };
    // $4000 + 8.75% tax = $4350 — NO rush ($150) / takedown ($150) / early-install discount.
    expect(snap.serverRecomputed).toBe(true);
    expect(snap.customerSelection.currentTotalUsd).toBeCloseTo(4350, 2);
  });

  it('gates on the snapshot minimum ($2,500): a $2,100 back-only selection is rejected', async () => {
    const { client } = makeSb(baseQuote({ result: PERM_RESULT, service_type: 'permanent' }));
    sbRef.current = client;
    const res = await POST(
      makeReq({ ...validBody, selectedItemIds: ['permanent-back'] }), // $2100 < $2500
      { params },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('below-minimum');
  });

  it('approves a permanent selection at or above $2,500', async () => {
    const { client } = makeSb(baseQuote({ result: PERM_RESULT, service_type: 'permanent' }));
    sbRef.current = client;
    const res = await POST(
      makeReq({ ...validBody, selectedItemIds: ['permanent-front'] }), // $4000 >= $2500
      { params },
    );
    expect(res.status).toBe(200);
  });

  // GAP 1 (P6b-2 review) — a permanent quote's color choice is validated + frozen
  // against the FIXED permanent scheme set, never the holiday swatches. A forged/
  // stale holiday id can't be frozen as a permanent color choice.
  it('rejects a holiday-only scheme id on a permanent quote → freezes as-designed', async () => {
    const { client, updatePayloads } = makeSb(
      baseQuote({ result: PERM_RESULT, service_type: 'permanent' }),
    );
    sbRef.current = client;
    const res = await POST(
      makeReq({ ...validBody, selectedItemIds: ['permanent-front'], colorSchemeId: 'candy-cane' }),
      { params },
    );
    expect(res.status).toBe(200);
    const sel = (updatePayloads[0].approval_snapshot as {
      customerSelection: { colorSchemeId: string; colorIds: string[] | null };
    }).customerSelection;
    expect(sel.colorSchemeId).toBe('as-designed'); // holiday id rejected → default
    expect(sel.colorIds).toBeNull();
  });

  it('freezes a valid permanent scheme (warm-white) with its resolved colorIds', async () => {
    const { client, updatePayloads } = makeSb(
      baseQuote({ result: PERM_RESULT, service_type: 'permanent' }),
    );
    sbRef.current = client;
    const res = await POST(
      makeReq({ ...validBody, selectedItemIds: ['permanent-front'], colorSchemeId: 'warm-white' }),
      { params },
    );
    expect(res.status).toBe(200);
    const sel = (updatePayloads[0].approval_snapshot as {
      customerSelection: { colorSchemeId: string; colorIds: string[] | null };
    }).customerSelection;
    expect(sel.colorSchemeId).toBe('warm-white');
    expect(sel.colorIds).toEqual(['warm-white']);
  });

  it('accepts build-your-own on a permanent quote (#88 P6b-4 — full color control)', async () => {
    const { client, updatePayloads } = makeSb(
      baseQuote({ result: PERM_RESULT, service_type: 'permanent' }),
    );
    sbRef.current = client;
    const res = await POST(
      makeReq({
        ...validBody,
        selectedItemIds: ['permanent-front'],
        colorSchemeId: 'custom',
        customPattern: ['red', 'blue'],
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const sel = (updatePayloads[0].approval_snapshot as {
      customerSelection: { colorSchemeId: string; customPattern: string[]; colorIds: string[] | null };
    }).customerSelection;
    expect(sel.colorSchemeId).toBe('custom'); // build-your-own now allowed for permanent
    expect(sel.customPattern).toEqual(['red', 'blue']);
    expect(sel.colorIds).toEqual(['red', 'blue']); // resolved from the custom pattern
  });

  it('freezes the permanent animation effect (defaults to Chase; null for holiday)', async () => {
    const perm = makeSb(baseQuote({ result: PERM_RESULT, service_type: 'permanent' }));
    sbRef.current = perm.client;
    await POST(makeReq({ ...validBody, selectedItemIds: ['permanent-front'], permanentEffect: 'cycle' }), { params });
    const permSel = (perm.updatePayloads[0].approval_snapshot as {
      customerSelection: { permanentEffect: string | null };
    }).customerSelection;
    expect(permSel.permanentEffect).toBe('cycle');

    // absent/invalid on a permanent quote → default Chase
    const perm2 = makeSb(baseQuote({ result: PERM_RESULT, service_type: 'permanent' }));
    sbRef.current = perm2.client;
    await POST(makeReq({ ...validBody, selectedItemIds: ['permanent-front'], permanentEffect: 'bogus' }), { params });
    expect((perm2.updatePayloads[0].approval_snapshot as {
      customerSelection: { permanentEffect: string | null };
    }).customerSelection.permanentEffect).toBe('chase');

    // a holiday quote never carries an effect
    const hol = makeSb(baseQuote());
    sbRef.current = hol.client;
    await POST(makeReq({ ...validBody, selectedItemIds: ['roofline-santas'], permanentEffect: 'chase' }), { params });
    expect((hol.updatePayloads[0].approval_snapshot as {
      customerSelection: { permanentEffect: string | null };
    }).customerSelection.permanentEffect).toBeNull();
  });

  // GAP 2 (P6b-2 review) — the warranty copy + version freeze into the snapshot for
  // permanent quotes, and is null for non-permanent (no leak onto holiday snapshots).
  it('freezes the current warranty copy + version into a permanent snapshot', async () => {
    const { client, updatePayloads } = makeSb(
      baseQuote({ result: PERM_RESULT, service_type: 'permanent' }),
    );
    sbRef.current = client;
    const res = await POST(
      makeReq({ ...validBody, selectedItemIds: ['permanent-front'] }),
      { params },
    );
    expect(res.status).toBe(200);
    const w = (updatePayloads[0].approval_snapshot as {
      permanentWarranty: { version: number; heading: string; bullets: string[] } | null;
    }).permanentWarranty;
    expect(w).not.toBeNull();
    expect(w!.version).toBe(1); // DEFAULT_PERMANENT_WARRANTY
    expect(w!.heading).toBe('Built to last a lifetime.');
    expect(w!.bullets).toHaveLength(6);
  });

  it('freezes NO warranty (null) on a non-permanent (holiday) approval', async () => {
    const { client, updatePayloads } = makeSb(baseQuote()); // holiday RESULT, no service_type
    sbRef.current = client;
    const res = await POST(
      makeReq({ ...validBody, selectedItemIds: ['roofline-santas'] }),
      { params },
    );
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as { permanentWarranty: unknown };
    expect(snap.permanentWarranty).toBeNull();
  });
});

describe('POST /api/quotes/[id]/approve — permanent bistro', () => {
  it('forces holiday fees OFF even if the body toggles rush/takedown/early-install', async () => {
    const { client, updatePayloads } = makeSb(
      baseQuote({ result: BISTRO_RESULT, service_type: 'permanent_bistro' }),
    );
    sbRef.current = client;
    const res = await POST(
      makeReq({
        ...validBody,
        selectedItemIds: ['permanent-bistro-0'], // $700
        rushSelected: true,
        takedownSelected: true,
        installTiming: 'september',
      }),
      { params },
    );
    expect(res.status).toBe(200);
    const snap = updatePayloads[0].approval_snapshot as {
      customerSelection: { rushSelected: boolean; takedownSelected: boolean; installTiming: string };
    };
    expect(snap.customerSelection.rushSelected).toBe(false);
    expect(snap.customerSelection.takedownSelected).toBe(false);
    expect(snap.customerSelection.installTiming).toBe('none');
  });

  it('gates on the bistro snapshot minimum ($500): a $200 poles-only selection is rejected', async () => {
    const { client } = makeSb(baseQuote({ result: BISTRO_RESULT, service_type: 'permanent_bistro' }));
    sbRef.current = client;
    const res = await POST(
      makeReq({ ...validBody, selectedItemIds: ['permanent-bistro-poles'] }), // $200 < $500
      { params },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('below-minimum');
  });

  // REGRESSION lock: pre-fix, `isPermanent ? … : undefined` made the gate fall
  // back to BUSINESS_RULES.minimumQuoteAmount ($1,000) for every non-permanent
  // service type, INCLUDING bistro — so a $700 selection (above the bistro
  // quote's own $500 gate) would have been wrongly rejected as below-minimum.
  it('REGRESSION: approves a $700 selection — above its own $500 gate, below the old $1,000 holiday default', async () => {
    const { client } = makeSb(baseQuote({ result: BISTRO_RESULT, service_type: 'permanent_bistro' }));
    sbRef.current = client;
    const res = await POST(
      makeReq({ ...validBody, selectedItemIds: ['permanent-bistro-0'] }), // $700
      { params },
    );
    expect(res.status).toBe(200);
  });

  it('gate 0 (no snapshot minimum set) approves any priced selection', async () => {
    const noMinResult = {
      ...BISTRO_RESULT,
      permanentBistroRatesSnapshot: { perFt: 30, perPole: 100, minimum: 0 },
    };
    const { client } = makeSb(baseQuote({ result: noMinResult, service_type: 'permanent_bistro' }));
    sbRef.current = client;
    const res = await POST(
      makeReq({ ...validBody, selectedItemIds: ['permanent-bistro-poles'] }), // $200
      { params },
    );
    expect(res.status).toBe(200);
  });
});
