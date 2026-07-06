// Tests for POST /api/quotes/[id]/amend (#83 Phase 4). Operator-gated; appends an
// immutable amendment trail, re-syncs the linked invoice, sets the re-consent
// status. The auth gate, Supabase, and jobs/getInvoiceByJob are mocked;
// amend.ts + computeInvoiceTotals run for real (the money math is what we verify).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const {
  sbRef,
  requireOperatorMock,
  getOperatorMock,
  getJobByQuoteMock,
  getInvoiceByJobMock,
  sendSmsMock,
  sendEmailMock,
  isHighLevelConfiguredMock,
} = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getJobByQuoteMock: vi.fn(async (): Promise<unknown> => null),
  getInvoiceByJobMock: vi.fn(async (): Promise<unknown> => null),
  sendSmsMock: vi.fn(async () => ({})),
  sendEmailMock: vi.fn(async () => ({})),
  isHighLevelConfiguredMock: vi.fn(() => true),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));
vi.mock('@/lib/jobs', () => ({ getJobByQuote: getJobByQuoteMock }));
vi.mock('@/lib/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/invoices')>();
  return { ...actual, getInvoiceByJob: getInvoiceByJobMock };
});
vi.mock('@/lib/integrations/highlevel', () => ({
  sendSms: sendSmsMock,
  sendEmail: sendEmailMock,
  isHighLevelConfigured: isHighLevelConfiguredMock,
}));

import { POST } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = (body: unknown) =>
  ({ json: async () => body, nextUrl: { origin: 'https://test.local' } }) as unknown as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

type Row = Record<string, unknown>;
// `single()` serves the initial load; `maybeSingle()` serves the pre-write re-read
// (the concurrency guard) — pass `fresh` to simulate a racing write.
function makeSb(quote: Row | null, fresh: Row | null = quote) {
  const updates: { quotes: Row[]; invoices: Row[] } = { quotes: [], invoices: [] };
  let table = '';
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: (t: string) => {
      table = t;
      return b;
    },
    select: () => b,
    update: (payload: Row) => {
      (updates as Record<string, Row[]>)[table].push(payload);
      return b;
    },
    eq: () => b,
    single: async () => ({ data: quote, error: quote ? null : { message: 'no rows' } }),
    maybeSingle: async () => ({ data: fresh, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
  });
  return { client: b, updates };
}

// A NON-diverged booking (agreed selection === the full quote at approval): the
// customer approved the whole $5,000 quote, and staff have since re-priced it up
// to $5,600 in the builder → the +$600 amendment delta is REAL. The frozen
// pricing.total ($5,000) is the approval-time full total the delta measures
// against (W1-004).
const BOOKED_QUOTE = {
  id: ID,
  status: 'booked',
  deposit_amount_usd: 2500,
  deposit_paid_at: '2026-01-01T00:00:00Z',
  result: { subtotalBeforeDiscount: 5600, discountAmount: 0, taxAmount: 0, total: 5600 },
  approval_snapshot: {
    customerSelection: { currentTotalUsd: 5000 },
    pricing: { total: 5000 },
    amendments: [],
  },
  customer_name: 'Alice Smith',
  highlevel_contact_id: 'hl-1',
  is_test: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue(null);
  getJobByQuoteMock.mockResolvedValue(null);
  getInvoiceByJobMock.mockResolvedValue(null);
  sbRef.current = null;
});

describe('POST /api/quotes/[id]/amend', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(req({ reason: 'add a wreath' }), ctx());
    expect(res.status).toBe(401);
  });

  it('400s when a reason is missing', async () => {
    const res = await POST(req({}), ctx());
    expect(res.status).toBe(400);
  });

  it('400s on an invalid quote id', async () => {
    const res = await POST(req({ reason: 'x' }), ctx('nope'));
    expect(res.status).toBe(400);
  });

  it('404s when the quote does not exist', async () => {
    sbRef.current = makeSb(null).client;
    const res = await POST(req({ reason: 'x' }), ctx());
    expect(res.status).toBe(404);
  });

  it('409s when the order is not booked (no deposit paid)', async () => {
    sbRef.current = makeSb({ ...BOOKED_QUOTE, deposit_paid_at: null }).client;
    const res = await POST(req({ reason: 'x' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('not-booked');
  });

  // W1-011: a booked order that was later CANCELLED (cancel leaves deposit_paid_at
  // intact but sets status='cancelled') must NOT be amendable — amending a dead
  // order records a trail entry and can text the customer a new balance. Reject 409.
  it('409s when the order is cancelled (terminal status) even though the deposit is paid', async () => {
    const sb = makeSb({ ...BOOKED_QUOTE, status: 'cancelled' });
    sbRef.current = sb.client;
    const res = await POST(req({ reason: 'add a wreath' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('not-amendable');
    expect(sb.updates.quotes).toHaveLength(0); // never wrote a trail entry
  });

  it('409s with no-change when the total is unchanged (re-price in the builder first)', async () => {
    // result.total === the snapshot agreed total → delta 0.
    const unchanged = { ...BOOKED_QUOTE, result: { total: 5000 } };
    sbRef.current = makeSb(unchanged).client;
    const res = await POST(req({ reason: 'x' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('no-change');
  });

  it('records the amendment trail, re-syncs the invoice, flags re-consent, and leaves status booked', async () => {
    const sb = makeSb(BOOKED_QUOTE);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    getInvoiceByJobMock.mockResolvedValue({ id: 'inv-1', balance: 2500, status: 'draft', tax_overridden: false });

    const res = await POST(req({ reason: 'added an extra wreath' }), ctx());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.amendment).toMatchObject({ previous_total: 5000, new_total: 5600, delta: 600, new_balance: 3100 });
    expect(json.requiresReconsent).toBe(true);
    // Status stays booked (the deposit is still paid) — re-consent lives in the trail.
    expect(json.status).toBe('booked');

    // Snapshot: the original is preserved + the entry appended (not overwritten);
    // the lifecycle status is NOT written (no illegal booked→changes_requested).
    const quoteUpdate = sb.updates.quotes[0];
    const snap = quoteUpdate.approval_snapshot as {
      customerSelection?: { currentTotalUsd?: number };
      amendments?: Array<{ new_total: number; reason: string }>;
    };
    expect(snap.customerSelection?.currentTotalUsd).toBe(5000);
    expect(snap.amendments).toHaveLength(1);
    expect(snap.amendments![0]).toMatchObject({ new_total: 5600, reason: 'added an extra wreath' });
    expect('status' in quoteUpdate).toBe(false);

    // Invoice re-synced to the amended totals (still has a balance → draft kept).
    expect(sb.updates.invoices[0]).toMatchObject({ total: 5600, balance: 3100, status: 'draft' });
  });

  // GAP 4 (P6b-2 review) — amend spreads the whole snapshot, so the frozen
  // permanent warranty + the frozen color choice a customer agreed to must survive
  // an amend unchanged (an amend must never silently alter agreed terms/colors).
  it('preserves the frozen permanentWarranty + colorIds across an amend', async () => {
    const frozen = {
      ...BOOKED_QUOTE,
      approval_snapshot: {
        customerSelection: { currentTotalUsd: 5000, colorSchemeId: 'warm-white', colorIds: ['warm-white'] },
        pricing: { total: 5000 },
        permanentWarranty: { eyebrow: 'Your Protection', heading: 'H', bullets: ['a'], version: 4 },
        amendments: [],
      },
    };
    const sb = makeSb(frozen);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    getInvoiceByJobMock.mockResolvedValue({ id: 'inv-1', balance: 2500, status: 'draft', tax_overridden: false });

    await POST(req({ reason: 'tweak' }), ctx());
    const snap = sb.updates.quotes[0].approval_snapshot as {
      permanentWarranty?: { version: number };
      customerSelection?: { colorIds?: string[] };
    };
    expect(snap.permanentWarranty?.version).toBe(4); // survived the spread
    expect(snap.customerSelection?.colorIds).toEqual(['warm-white']);
  });

  it('reopens an already-PAID invoice to awaiting_payment when amended up', async () => {
    const sb = makeSb(BOOKED_QUOTE);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    getInvoiceByJobMock.mockResolvedValue({ id: 'inv-1', balance: 0, status: 'paid', tax_overridden: false });

    const res = await POST(req({ reason: 'added an extra wreath' }), ctx());
    expect(res.status).toBe(200);
    expect(sb.updates.invoices[0]).toMatchObject({ balance: 3100, status: 'awaiting_payment' });
  });

  // ── W1-004: the amend delta must not fabricate a phantom increase on a
  // selection-DIVERGED booking (customer deselected items at approval).
  //
  // A DIVERGED booking: the customer approved a $5,000 SELECTION of a $5,600 full
  // quote (pricing.total frozen at approval). The amend delta is measured on the
  // agreed basis as the CHANGE in the full quote (result.total − pricing.total),
  // NOT (result.total − agreedTotal) — which would invent a +$600 increase.

  const DIVERGED_QUOTE = {
    ...BOOKED_QUOTE,
    approval_snapshot: {
      customerSelection: { currentTotalUsd: 5000 },
      pricing: { total: 5600 }, // full quote at approval time
      amendments: [],
    },
  };

  it('does NOT fabricate a phantom increase when the builder was never re-priced (diverged selection → no-change)', async () => {
    // No builder edit: result.total is still the frozen full total (5600). The
    // OLD code computed 5600 − 5000 = +600 (phantom); the fix reads delta 0.
    const noEdit = { ...DIVERGED_QUOTE, result: { total: 5600 } };
    const sb = makeSb(noEdit);
    sbRef.current = sb.client;
    const res = await POST(req({ reason: 'billing note only' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('no-change'); // NOT a +$600 amendment
    expect(sb.updates.quotes).toHaveLength(0);
  });

  it('amends UP on a diverged selection: delta is the full-quote change on the agreed basis', async () => {
    // Staff re-priced the full quote 5600 → 5900 (+$300 of real work).
    const amendUp = { ...DIVERGED_QUOTE, result: { total: 5900 } };
    const sb = makeSb(amendUp);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    getInvoiceByJobMock.mockResolvedValue({ id: 'inv-1', balance: 2500, status: 'draft', tax_overridden: false });

    const res = await POST(req({ reason: 'added a section' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    // previous = agreed 5000; new = 5000 + (5900 − 5600) = 5300; delta +300 (NOT +900).
    expect(json.amendment).toMatchObject({ previous_total: 5000, new_total: 5300, delta: 300 });
    // Invoice re-synced to the AGREED new total, not the full 5900: balance 5300 − 2500.
    expect(sb.updates.invoices[0]).toMatchObject({ total: 5300, balance: 2800 });
  });

  it('amends DOWN on a diverged selection: delta is negative on the agreed basis', async () => {
    // Staff removed work: full quote 5600 → 5300 (−$300).
    const amendDown = { ...DIVERGED_QUOTE, result: { total: 5300 } };
    const sb = makeSb(amendDown);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    getInvoiceByJobMock.mockResolvedValue({ id: 'inv-1', balance: 2500, status: 'draft', tax_overridden: false });

    const res = await POST(req({ reason: 'removed a section' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    // previous = agreed 5000; new = 5000 + (5300 − 5600) = 4700; delta −300.
    expect(json.amendment).toMatchObject({ previous_total: 5000, new_total: 4700, delta: -300 });
    expect(sb.updates.invoices[0]).toMatchObject({ total: 4700, balance: 2200 });
  });

  // ── #125-1: the amend re-sync is the THIRD invoice write-path (after
  // createInvoiceFromJob + setInvoiceTaxOverride, both fixed by #384). On a
  // TAX-OVERRIDDEN invoice the removable tax must be SCALED to the amended
  // (possibly partial) total — else the WHOLE-quote tax is subtracted from a
  // partial total and the customer is UNDER-BILLED.
  it('scales the removable tax to the amended total on a tax-overridden invoice (#125-1)', async () => {
    // Full quote, tax-inclusive @ 8.75%: taxable 5000 → tax 437.50 → total 5437.50.
    // Diverged: the customer approved a $2,175 selection of a $4,350 full quote
    // (pricing.total frozen at approval); staff re-priced the full quote to 5437.50.
    // Amended agreed total = 2175 + (5437.50 − 4350) = 3262.50.
    const taxQuote = {
      ...BOOKED_QUOTE,
      result: { subtotalBeforeDiscount: 5000, discountAmount: 0, taxAmount: 437.5, total: 5437.5 },
      approval_snapshot: {
        customerSelection: { currentTotalUsd: 2175 },
        pricing: { total: 4350 },
        amendments: [],
      },
    };
    const sb = makeSb(taxQuote);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    // The linked invoice has tax EXEMPTED (a tax-exempt customer).
    getInvoiceByJobMock.mockResolvedValue({ id: 'inv-1', balance: 1000, status: 'draft', tax_overridden: true });

    const res = await POST(req({ reason: 'tax-exempt amend' }), ctx());
    expect(res.status).toBe(200);

    // Correct: remove only the tax embedded in the AGREED 3262.50 (= 262.50), so
    // total = 3000.00. The bug removed the FULL-quote tax (437.50) → 2825.00.
    const invUpdate = sb.updates.invoices[0];
    expect(invUpdate.total).toBe(3000);
    expect(invUpdate.balance).toBe(500); // 3000 − 2500 deposit paid
  });

  it('409s (concurrent-amend) when the trail grew between read and write', async () => {
    // Initial read: 0 amendments; the pre-write re-read sees 1 → a racing amend.
    const racedFresh = {
      ...BOOKED_QUOTE,
      approval_snapshot: { customerSelection: { currentTotalUsd: 5000 }, amendments: [{ new_total: 5600 }] },
    };
    const sb = makeSb(BOOKED_QUOTE, racedFresh);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    getInvoiceByJobMock.mockResolvedValue(null);

    const res = await POST(req({ reason: 'added an extra wreath' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('concurrent-amend');
    expect(sb.updates.quotes).toHaveLength(0); // never wrote
  });

  it('does not touch an invoice when the job has not been completed yet', async () => {
    const sb = makeSb(BOOKED_QUOTE);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    getInvoiceByJobMock.mockResolvedValue(null); // not completed → no invoice

    const res = await POST(req({ reason: 'added an extra wreath' }), ctx());
    expect(res.status).toBe(200);
    expect(sb.updates.invoices).toHaveLength(0);
    expect(sb.updates.quotes).toHaveLength(1); // trail still recorded
  });

  it('notifies the customer (SMS + email) when notifyCustomer is set on a non-test quote', async () => {
    sbRef.current = makeSb(BOOKED_QUOTE).client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    getInvoiceByJobMock.mockResolvedValue({ id: 'inv-1', balance: 2500, status: 'draft', tax_overridden: false });

    const res = await POST(req({ reason: 'extra wreath', notifyCustomer: true }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.notified).toBe(true);
    expect(sendSmsMock).toHaveBeenCalledOnce();
    expect(sendEmailMock).toHaveBeenCalledOnce();
  });

  it('does NOT send a real message for a TEST quote (test-safe)', async () => {
    sbRef.current = makeSb({ ...BOOKED_QUOTE, is_test: true }).client;
    getJobByQuoteMock.mockResolvedValue(null);

    const res = await POST(req({ reason: 'extra wreath', notifyCustomer: true }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.notified).toBe(false);
    expect(json.notifyError).toBe('test-quote');
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('does not notify when notifyCustomer is absent', async () => {
    sbRef.current = makeSb(BOOKED_QUOTE).client;
    getJobByQuoteMock.mockResolvedValue(null);
    const res = await POST(req({ reason: 'extra wreath' }), ctx());
    const json = await res.json();
    expect(json.notified).toBe(false);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  // B10 fix: amend-down that settles the invoice → paid_at must be stamped.
  it('stamps paid_at when an amend-down settles the invoice to paid', async () => {
    // Deposit $2500 > new total $2000 → balance = 0 → settle to paid.
    const amendDownQuote = {
      ...BOOKED_QUOTE,
      deposit_amount_usd: 2500,
      result: { subtotalBeforeDiscount: 2000, discountAmount: 0, taxAmount: 0, total: 2000 },
    };
    const sb = makeSb(amendDownQuote);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    // Invoice currently awaiting_payment with a positive balance (pre-amend state).
    getInvoiceByJobMock.mockResolvedValue({
      id: 'inv-1', balance: 500, status: 'awaiting_payment', tax_overridden: false, paid_at: null,
    });

    const res = await POST(req({ reason: 'removed a section' }), ctx());
    expect(res.status).toBe(200);

    const invUpdate = sb.updates.invoices[0];
    expect(invUpdate).toBeDefined();
    expect(invUpdate.status).toBe('paid');
    expect(invUpdate.paid_at).toBeTruthy(); // B10: must be stamped, not null
    expect(typeof invUpdate.paid_at).toBe('string');
  });

  // B10 fix: amend-up that reopens a paid invoice → paid_at must be cleared.
  it('clears paid_at when an amend-up reopens a paid invoice to awaiting_payment', async () => {
    const sb = makeSb(BOOKED_QUOTE); // new total $5600 > deposit $2500 → balance $3100
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    // Invoice currently paid (balance collected before the amend).
    getInvoiceByJobMock.mockResolvedValue({
      id: 'inv-1', balance: 0, status: 'paid', tax_overridden: false, paid_at: '2026-06-15T10:00:00Z',
    });

    const res = await POST(req({ reason: 'added a section' }), ctx());
    expect(res.status).toBe(200);

    const invUpdate = sb.updates.invoices[0];
    expect(invUpdate).toBeDefined();
    expect(invUpdate.status).toBe('awaiting_payment');
    expect(invUpdate.paid_at).toBeNull(); // B10: must be cleared when reopened
  });

  // B10 hardening: the defensive canTransition guard must NOT block any legal amend
  // re-sync transition. draft→paid (amend-down settle) is legal, so the invoice is
  // still written (guard is transparent for real amends — defense-in-depth only).
  it('does NOT block a legal amend transition (canTransition guard is transparent)', async () => {
    const amendDownQuote = {
      ...BOOKED_QUOTE,
      deposit_amount_usd: 2500,
      result: { subtotalBeforeDiscount: 2000, discountAmount: 0, taxAmount: 0, total: 2000 },
    };
    const sb = makeSb(amendDownQuote);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    // draft invoice with a balance → amend-down settles it to paid (draft→paid legal).
    getInvoiceByJobMock.mockResolvedValue({
      id: 'inv-1', balance: 500, status: 'draft', tax_overridden: false, paid_at: null,
    });

    const res = await POST(req({ reason: 'removed a section' }), ctx());
    expect(res.status).toBe(200);
    // The write happened — the guard permitted the legal draft→paid transition.
    expect(sb.updates.invoices).toHaveLength(1);
    expect(sb.updates.invoices[0]).toMatchObject({ status: 'paid' });
  });

  // B10 fix: when the invoice was settled (paid) between the route's initial read
  // and the re-sync, the re-read catches the fresh status and applies the correct
  // transition (amend-up: paid → awaiting_payment, not the stale draft).
  it('uses a fresh invoice read before re-syncing (reduces clobber window)', async () => {
    // The mock returns 'paid' — simulating the invoice being settled concurrently.
    const sb = makeSb(BOOKED_QUOTE);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    // getInvoiceByJob is now called TWICE: once for the initial read, once for the
    // pre-sync re-read. Both return paid in this scenario.
    getInvoiceByJobMock.mockResolvedValue({
      id: 'inv-1', balance: 0, status: 'paid', tax_overridden: false, paid_at: '2026-06-15T10:00:00Z',
    });

    const res = await POST(req({ reason: 'added a section' }), ctx());
    expect(res.status).toBe(200);

    const invUpdate = sb.updates.invoices[0];
    // Amend-up: new balance > 0, old status paid → awaiting_payment, paid_at cleared.
    expect(invUpdate.status).toBe('awaiting_payment');
    expect(invUpdate.paid_at).toBeNull();
  });
});
