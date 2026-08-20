// Tests for POST /api/quotes/[id]/amend (#83 Phase 4). Operator-gated; appends an
// immutable amendment trail, re-syncs the linked invoice, sets the re-consent
// status. The auth gate, Supabase, and jobs/getInvoiceByJob are mocked;
// amend.ts + computeInvoiceTotals run for real (the money math is what we verify).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';
// Integration-shaped test (delta-verify HIGH, fix round 3): the portal READ
// path, run for real (not mocked) against the EXACT snapshot this route
// persists — proves the card, not just the SMS/email, agrees with what got
// billed. See the describe block at the bottom of this file.
import { quoteRowToPortalQuote, type QuoteRowForPortal } from '@/lib/portal/adapter';
import type { PortalPhotos } from '@/lib/portal/photos';
import { calculateQuote, type QuoteInputs } from '@/lib/pricing/pricingEngine';

const {
  sbRef,
  requireOperatorMock,
  getOperatorMock,
  getJobByQuoteMock,
  getInvoiceByJobMock,
  appendRetiredTxnMock,
  sendSmsMock,
  sendEmailMock,
  isHighLevelConfiguredMock,
} = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getJobByQuoteMock: vi.fn(async (): Promise<unknown> => null),
  getInvoiceByJobMock: vi.fn(async (): Promise<unknown> => null),
  appendRetiredTxnMock: vi.fn(async (): Promise<boolean> => true),
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
  return { ...actual, getInvoiceByJob: getInvoiceByJobMock, appendRetiredTxn: appendRetiredTxnMock };
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
function makeSb(
  quote: Row | null,
  fresh: Row | null = quote,
  quoteUpdateRows: Row[] = [{ id: ID }],
) {
  const updates: { quotes: Row[]; invoices: Row[] } = { quotes: [], invoices: [] };
  const eqCalls: Array<[string, unknown]> = [];
  let table = '';
  let updating = false;
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: (t: string) => {
      table = t;
      return b;
    },
    select: () => b,
    update: (payload: Row) => {
      updating = true;
      (updates as Record<string, Row[]>)[table].push(payload);
      return b;
    },
    eq: (column: string, value: unknown) => {
      eqCalls.push([column, value]);
      return b;
    },
    single: async () => ({ data: quote, error: quote ? null : { message: 'no rows' } }),
    maybeSingle: async () => ({ data: fresh, error: null }),
    then: (resolve: (v: unknown) => void) => {
      const data = updating && table === 'quotes' ? quoteUpdateRows : null;
      updating = false;
      resolve({ data, error: null });
    },
  });
  return { client: b, updates, eqCalls };
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

  // WT-21: cancel/route.ts writes the linked JOB to 'cancelled' first, then
  // best-effort writes the source quote's status — if that quote-status write
  // fails, the quote can still read 'booked' (or any non-terminal status)
  // while its job already reads 'cancelled'. Amend must gate on the job too,
  // independent of the quote's own status column.
  it('409s when the linked job is cancelled, even though the quote status still reads booked', async () => {
    const sb = makeSb(BOOKED_QUOTE); // quote.status is still 'booked'
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1', status: 'cancelled' });

    const res = await POST(req({ reason: 'add a wreath' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('job-cancelled');
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
    expect(snap.amendments![0]).toMatchObject({
      new_total: 5600,
      reason: 'added an extra wreath',
      consent: { status: 'pending' },
    });
    expect('status' in quoteUpdate).toBe(false);
    expect(sb.eqCalls).toContainEqual([
      'approval_snapshot',
      JSON.stringify(BOOKED_QUOTE.approval_snapshot),
    ]);

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

  it('409s when the atomic snapshot compare-and-swap loses after the re-read', async () => {
    const sb = makeSb(BOOKED_QUOTE, BOOKED_QUOTE, []);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    getInvoiceByJobMock.mockResolvedValue(null);

    const res = await POST(req({ reason: 'simultaneous amendment' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('concurrent-amend');
    expect(sb.updates.quotes).toHaveLength(1); // attempted, but CAS matched no row
    expect(sb.updates.invoices).toHaveLength(0);
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

  const usdText = (n: number): string =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // sendSmsMock is declared as vi.fn(async () => ({})) — no typed params — so
  // .mock.calls[0][0] has no element type. Narrow once, here.
  const sentSmsMessage = (): string => {
    const call = sendSmsMock.mock.calls[0] as unknown as [{ message: string }] | undefined;
    return call?.[0]?.message ?? '';
  };

  // Delta-verify HIGH: dueAfterInstall was first derived from `!invoice`, which
  // reads null both when the job is genuinely pre-install AND when the invoice
  // lookup fails or a completed job's invoice creation failed and was never
  // retried. These cover the DERIVATION in this route, not just the message
  // builders it feeds (which take the flag as a literal).
  it('tells a pre-install customer the balance is due after installation', async () => {
    sbRef.current = makeSb(BOOKED_QUOTE).client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1', status: 'to_schedule' });
    getInvoiceByJobMock.mockResolvedValue(null);

    await POST(req({ reason: 'extra wreath', notifyCustomer: true }), ctx());
    expect(sentSmsMessage()).toContain('after installation');
  });

  it('makes NO timing claim once the job is already installed', async () => {
    sbRef.current = makeSb(BOOKED_QUOTE).client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
    getInvoiceByJobMock.mockResolvedValue({ id: 'inv-1', balance: 2500, status: 'draft', tax_overridden: false });

    await POST(req({ reason: 'post-install correction', notifyCustomer: true }), ctx());
    expect(sentSmsMessage()).not.toContain('after installation');
  });

  it('makes NO timing claim when an installed job has no invoice (failed create) — fails safe', async () => {
    // The exact shape that broke the first fix: jobs/[id]/complete commits the
    // status advance BEFORE creating the invoice, so an installed job can sit
    // with a null invoice.
    sbRef.current = makeSb(BOOKED_QUOTE).client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1', status: 'installed' });
    getInvoiceByJobMock.mockResolvedValue(null);

    await POST(req({ reason: 'post-install correction', notifyCustomer: true }), ctx());
    expect(sentSmsMessage()).not.toContain('after installation');
  });

  it('makes NO timing claim when the job row cannot be read — fails safe', async () => {
    // getJobByQuote swallows a read error and returns null; an unknown state
    // must not assert a timing the customer could act on.
    sbRef.current = makeSb(BOOKED_QUOTE).client;
    getJobByQuoteMock.mockResolvedValue(null);
    getInvoiceByJobMock.mockResolvedValue(null);

    await POST(req({ reason: 'extra wreath', notifyCustomer: true }), ctx());
    expect(sentSmsMessage()).not.toContain('after installation');
  });

  // Jason 2026-08-19: the notice must quote what the customer is actually
  // BILLED. On a tax-overridden invoice computeInvoiceTotals removes the tax
  // from the invoice total, while the amendment trail's new_balance keeps it —
  // so the trail figure would overstate the balance. 2 of 4 prod invoices are
  // tax_overridden, so this is an ordinary case.
  it('quotes the INVOICE balance, not the trail balance, on a tax-overridden invoice', async () => {
    // BOOKED_QUOTE carries taxAmount 0, where a tax override removes nothing and
    // the two figures trivially agree — that fixture cannot show the divergence.
    // Give this one real tax: 5600 total including 450 tax.
    const TAXED = {
      ...BOOKED_QUOTE,
      result: { subtotalBeforeDiscount: 5150, discountAmount: 0, taxAmount: 450, total: 5600 },
    };
    const sb = makeSb(TAXED);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
    getInvoiceByJobMock.mockResolvedValue({
      id: 'inv-1',
      balance: 2500,
      status: 'draft',
      tax_overridden: true,
      // FIX A (fix round 4): a real InvoiceRow.total is NOT NULL — give this
      // fixture one (a real prior invoice total), matching how the
      // pre-write invoice_basis stamp reads it. Without it the route can't
      // stamp previous_total, so resolveAmendmentBasis (shared by the trail
      // stamp, the SMS/email, and the portal card as of fix round 4) falls
      // back to the TRAIL basis for total/balance/delta together — which
      // would make this test assert the trail balance and stop testing what
      // its own name claims.
      total: 5000,
    });

    const res = await POST(req({ reason: 'post-install add-on', notifyCustomer: true }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);

    // The invoice write that just happened is what the customer will actually
    // be billed — assert the message quotes THAT, and that it genuinely
    // differs from the trail's own balance (otherwise this proves nothing).
    const billed = (sb.updates.invoices[0] as { balance: number }).balance;
    expect(billed).not.toBe(json.amendment.new_balance);
    expect(sentSmsMessage()).toContain(usdText(billed));
    expect(sentSmsMessage()).not.toContain(usdText(json.amendment.new_balance));
  });

  // FIX4 (review HIGH, money): the SMS/email must state a delta that
  // reconciles with newTotalUsd — a reader computing "newTotalUsd − deltaUsd"
  // must land on the REAL prior invoiced total, not an arbitrary number.
  // Before this fix, deltaUsd was unconditionally the TRAIL delta while
  // newTotalUsd was the INVOICE-basis total — different bases, so the two
  // numbers in the same sentence didn't add up to anything real.
  it('states a delta that reconciles with the invoice-basis total on a tax-overridden invoice', async () => {
    // Full quote 5600 (450 tax on a 5150 subtotal). Approval: agreed $5,000 of
    // that $5,600 full total (a diverged selection) — approval-time full total
    // frozen at snap.pricing.total 5000. This amendment brings the full total
    // to $5,600 (no builder edit — BOOKED_QUOTE.result IS already 5600), so
    // the AGREED total also rises to $5,600 (trail: previous 5000 → new 5600,
    // delta +600).
    //
    // The invoice was created earlier at the ORIGINAL $5,000 agreed total,
    // tax-scaled: scaledTax = round2(450 × 5000/5600) = 401.79,
    // invoice.total = 5000 − 401.79 = 4598.21 (the PRE-resync figure below).
    // After this amendment resyncs it to the new $5,600 agreed total:
    // scaledTax = round2(450 × 5600/5600) = 450.00, invoice.total =
    // 5600 − 450.00 = 5150.00. Invoice-basis delta = 5150.00 − 4598.21 =
    // 551.79 — NOT the trail's 600.00, and NOT reconstructable by subtracting
    // the whole $450 tax either (the two invoices don't share a tax basis).
    const TAXED = {
      ...BOOKED_QUOTE,
      result: { subtotalBeforeDiscount: 5150, discountAmount: 0, taxAmount: 450, total: 5600 },
    };
    sbRef.current = makeSb(TAXED).client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
    getInvoiceByJobMock.mockResolvedValue({
      id: 'inv-1',
      balance: 2500,
      status: 'draft',
      tax_overridden: true,
      total: 4598.21, // the invoice's total BEFORE this amendment's resync
    });

    const res = await POST(req({ reason: 'post-install add-on', notifyCustomer: true }), ctx());
    expect(res.status).toBe(200);

    const sms = sentSmsMessage();
    // The message states the invoice-basis new total (5150.00) and MUST pair
    // it with the invoice-basis delta (551.79) — not the trail's 600.00.
    expect(sms).toContain(usdText(5150));
    expect(sms).toContain(usdText(551.79));
    expect(sms).not.toContain(usdText(600));
    // Prove it reconciles: newTotalUsd − deltaUsd must equal the REAL prior
    // invoiced total (4598.21), the number a reader would infer.
    expect(Math.round((5150 - 551.79) * 100) / 100).toBe(4598.21);

    const emailCall = sendEmailMock.mock.calls[0] as unknown as [{ html: string }] | undefined;
    const emailHtml = emailCall?.[0]?.html ?? '';
    expect(emailHtml).toContain(usdText(5150));
    expect(emailHtml).toContain(usdText(551.79));
    expect(emailHtml).not.toContain(usdText(600));
  });

  // FIX A / FIX E (fix round 4): the residual case the brief asked to be
  // reasoned about explicitly — the invoice re-sync fails AFTER the
  // amendment (with its invoice_basis already stamped, pre-write) is
  // durably recorded. Simulated here via a concurrent CANCELLATION of the
  // invoice landing AFTER the pre-basis re-read (task (a), fix round 5 — see
  // below) but before the re-sync's own fresh re-read (which bails out on a
  // cancelled invoice without writing anything — resyncInvoiceToAgreedTotal's
  // first guard). Before FIX A, the SMS would have used the (never-happened)
  // real resync outcome — null, falling back to the TRAIL balance — while any
  // comparable stamp would've been skipped by the same nullness. After FIX A,
  // the SMS and the stamped trail entry both read the SAME pre-computed
  // `amendment.invoice_basis`, so they still agree with each other; only the
  // invoices TABLE itself is left stale (a pre-existing, separately-known
  // best-effort characteristic of the re-sync, not something this fix changes).
  it('when the invoice re-sync fails after the amendment is recorded, the SMS and the stamped trail entry still agree with each other', async () => {
    const TAXED = {
      ...BOOKED_QUOTE,
      result: { subtotalBeforeDiscount: 5150, discountAmount: 0, taxAmount: 450, total: 5600 },
    };
    const sb = makeSb(TAXED);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
    const liveInvoice = {
      id: 'inv-1',
      balance: 2500,
      status: 'draft' as const,
      tax_overridden: true,
      total: 4598.21,
    };
    // getInvoiceByJob is now called THREE times: (1) the route's own early
    // read, (2) task (a)'s pre-basis re-read (right before the invoice_basis
    // stamp is computed — still sees the live, non-cancelled invoice, so the
    // stamp is unaffected here), (3) resyncInvoiceToAgreedTotal's own fresh
    // re-read (B10) — simulate the concurrent cancellation landing in THAT
    // gap, between (2) and (3), same as this test originally modeled between
    // (1) and (2) before task (a) added the middle read.
    getInvoiceByJobMock
      .mockResolvedValueOnce(liveInvoice)
      .mockResolvedValueOnce(liveInvoice)
      .mockResolvedValueOnce({ ...liveInvoice, status: 'cancelled' as const });

    const res = await POST(req({ reason: 'post-install add-on', notifyCustomer: true }), ctx());
    expect(res.status).toBe(200);

    // The invoices table was never actually written (resync bailed early).
    expect(sb.updates.invoices).toHaveLength(0);

    // The trail entry still carries the invoice-basis figures computed
    // BEFORE the resync ran.
    const quoteWrite = sb.updates.quotes[0];
    const snap = quoteWrite.approval_snapshot as { amendments?: Array<{ invoice_basis?: unknown }> };
    const persisted = snap.amendments?.[snap.amendments.length - 1];
    expect(persisted?.invoice_basis).toEqual({ previous_total: 4598.21, new_total: 5150, delta: 551.79 });

    // The SMS agrees with that SAME stamp — not with the trail basis (5600 /
    // 600.00), which is what a resync-outcome-driven notify would have sent
    // once the (never-happened) resync reported null.
    const sms = sentSmsMessage();
    expect(sms).toContain(usdText(5150));
    expect(sms).toContain(usdText(551.79));
    expect(sms).not.toContain(usdText(5600));
  });

  // Task (a), fix round 5: proves the invoice_basis STAMP is computed from a
  // FRESH invoice re-read taken immediately before the stamp, not from the
  // `invoice` loaded earlier in the request (before computeAmendment / the
  // no-change guard ran). Two DIFFERENT invoice reads simulate a concurrent
  // invoice change (e.g. a manual edit or a partial-payment webhook) landing
  // in that window: the first (route's initial load) returns total 5000, the
  // second (this fix's pre-basis re-read) returns total 4900. Had the stamp
  // still used the stale first read, previous_total/delta would read
  // 5000/600 instead of 4900/700.
  it('stamps invoice_basis from a FRESH invoice re-read, not the one loaded earlier in the request', async () => {
    const sb = makeSb(BOOKED_QUOTE);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    const staleInvoice = { id: 'inv-1', balance: 2500, status: 'draft' as const, tax_overridden: false, total: 5000 };
    const freshInvoice = { id: 'inv-1', balance: 2400, status: 'draft' as const, tax_overridden: false, total: 4900 };
    // 1st call = the route's initial read; 2nd call = task (a)'s pre-basis
    // re-read; every call after that (resync's own B10 re-read) gets the
    // SAME fresh value, so the actual invoice write agrees with the stamp.
    getInvoiceByJobMock
      .mockResolvedValueOnce(staleInvoice)
      .mockResolvedValueOnce(freshInvoice)
      .mockResolvedValue(freshInvoice);

    const res = await POST(req({ reason: 'concurrent invoice edit' }), ctx());
    expect(res.status).toBe(200);

    const quoteUpdate = sb.updates.quotes[0];
    const snap = quoteUpdate.approval_snapshot as {
      amendments?: Array<{ invoice_basis?: { previous_total: number; new_total: number; delta: number } }>;
    };
    const persisted = snap.amendments?.[snap.amendments!.length - 1];
    expect(persisted?.invoice_basis).toEqual({ previous_total: 4900, new_total: 5600, delta: 700 });
  });

  it('falls back to the trail balance when there is no invoice yet', async () => {
    sbRef.current = makeSb(BOOKED_QUOTE).client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1', status: 'to_schedule' });
    getInvoiceByJobMock.mockResolvedValue(null);

    const res = await POST(req({ reason: 'extra wreath', notifyCustomer: true }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(sentSmsMessage()).toContain(usdText(json.amendment.new_balance));
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

  // #170(b): reopening a PAID invoice retires the settled Valor txn to
  // valor_txn_log (via the CAS'd appendRetiredTxn — #640 review MED) and
  // clears the live slot, so the NEW balance is chargeable (no misleading
  // 'already-charged' 409) and the old record survives.
  it('rotates the settled Valor txn via appendRetiredTxn when an amend-up reopens a paid invoice', async () => {
    const sb = makeSb(BOOKED_QUOTE);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    getInvoiceByJobMock.mockResolvedValue({
      id: 'inv-1', balance: 0, status: 'paid', tax_overridden: false, paid_at: '2026-06-15T10:00:00Z',
      valor_balance_txn_id: 'TXN-OLD-7', valor_receipt_url: 'https://valor/receipt/7', valor_txn_log: null,
    });

    const res = await POST(req({ reason: 'added a section' }), ctx());
    expect(res.status).toBe(200);

    // The money re-sync itself carries NO rotation fields (it must stay
    // unconditional; the rotation is a separate CAS'd write).
    const invUpdate = sb.updates.invoices[0];
    expect(invUpdate.status).toBe('awaiting_payment');
    expect(invUpdate).not.toHaveProperty('valor_txn_log');
    expect(invUpdate).not.toHaveProperty('valor_balance_txn_id');

    expect(appendRetiredTxnMock).toHaveBeenCalledWith(
      'inv-1',
      expect.objectContaining({
        txnId: 'TXN-OLD-7',
        receiptUrl: 'https://valor/receipt/7',
        settledAt: '2026-06-15T10:00:00Z',
        reason: 'amend-reopen',
      }),
      { clearLive: { expectTxnId: 'TXN-OLD-7' } },
    );
  });

  it('does NOT rotate when the reopened invoice never had a real txn id', async () => {
    const sb = makeSb(BOOKED_QUOTE);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    // Paid outside Valor (cash) — no txn to rotate.
    getInvoiceByJobMock.mockResolvedValue({
      id: 'inv-1', balance: 0, status: 'paid', tax_overridden: false, paid_at: '2026-06-15T10:00:00Z',
      valor_balance_txn_id: null, valor_receipt_url: null, valor_txn_log: null,
    });

    const res = await POST(req({ reason: 'added a section' }), ctx());
    expect(res.status).toBe(200);

    const invUpdate = sb.updates.invoices[0];
    expect(invUpdate.status).toBe('awaiting_payment');
    expect(appendRetiredTxnMock).not.toHaveBeenCalled();
  });
});

// Delta-verify HIGH (fix round 3): the previous round's portal card
// RECONSTRUCTED previousTotalUsd/newTotalUsd by scaling the trail figures
// through the row's CURRENT full-quote pricing — correct for new_total (the
// current state produced it) but wrong for previous_total (priced against
// an earlier state), so the card could show numbers that disagreed with
// what the SMS/email actually said and what the invoice actually billed.
//
// This is an INTEGRATION-shaped test, not another adapter unit test: it
// drives the REAL route handler (POST), reads the EXACT approval_snapshot
// the route persisted to Supabase (via the sb fake below) straight back out
// through the REAL, un-mocked `quoteRowToPortalQuote` — the same function
// the portal page calls — and checks the resulting card figures against the
// SAME SMS text the route sent. The existing adapter unit tests (in
// adapter.test.ts) construct one static `result` and feed it to both the
// "previous" and "current" side of the math, which can only prove a formula
// is applied consistently — never that it matches what actually happened,
// which is exactly why the round-2 bug shipped past them.
describe('POST /api/quotes/[id]/amend → portal read path — card/SMS/email money-basis agreement (delta-verify HIGH)', () => {
  const PHOTOS: PortalPhotos = { beforeUrl: null, afterUrl: null, alt: null };
  const usdText = (n: number): string =>
    n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

  it('the portal card, the SMS, and the invoice all agree — on a tax-overridden invoice where the PRIOR pricing state genuinely differs from the current one', async () => {
    // Full quote 5600 (450 tax on a 5150 subtotal) — this IS the row's
    // CURRENT full-quote pricing (quote.result), the exact thing the broken
    // reconstruction would have scaled previous_total through.
    const TAXED = {
      ...BOOKED_QUOTE,
      result: { subtotalBeforeDiscount: 5150, discountAmount: 0, taxAmount: 450, total: 5600 },
    };
    const sb = makeSb(TAXED);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1', status: 'requires_invoicing' });
    // The invoice was created EARLIER, at a DIFFERENT (lower) agreed total —
    // a genuinely prior pricing state, not derivable from TAXED.result at all.
    getInvoiceByJobMock.mockResolvedValue({
      id: 'inv-1',
      balance: 2500,
      status: 'draft',
      tax_overridden: true,
      total: 4598.21, // the invoice's total BEFORE this amendment's resync
    });

    const res = await POST(req({ reason: 'post-install add-on', notifyCustomer: true }), ctx());
    expect(res.status).toBe(200);

    // 1) The SMS states the invoice-basis figures (same math the sibling
    // test above verifies in detail: previous 4598.21 → new 5150.00, delta
    // 551.79 — NOT the trail's previous 5000 / new 5600 / delta 600).
    const smsCall = sendSmsMock.mock.calls[0] as unknown as [{ message: string }] | undefined;
    const sms = smsCall?.[0]?.message ?? '';
    expect(sms).toContain(usdText(5150));
    expect(sms).toContain(usdText(551.79));

    // 2) The invoice was actually billed 5150.00.
    expect(sb.updates.invoices[0]).toMatchObject({ total: 5150, balance: 2650 });

    // 3) FIX A (fix round 4): invoice_basis rides in on the SAME write that
    // records the amendment — pin the atomicity (this was TWO writes to
    // 'quotes' before fix round 4; a lost race on the second could leave the
    // trail entry without invoice_basis even though the SMS already sent
    // invoice-basis figures — the HIGH this fix eliminates).
    expect(sb.updates.quotes).toHaveLength(1);
    const lastQuoteWrite = sb.updates.quotes[sb.updates.quotes.length - 1];
    // Cast from `unknown` (the mock's Row type) straight to the REAL
    // approval_snapshot type — no hand-rolled narrow shape to drift from
    // amend.ts's actual AmendmentTrailEntry.
    const persistedSnapshot = lastQuoteWrite.approval_snapshot as QuoteRowForPortal['approval_snapshot'];
    const persistedAmendments = persistedSnapshot?.amendments ?? [];
    const persistedAmendment = persistedAmendments[persistedAmendments.length - 1];
    expect(persistedAmendment?.invoice_basis).toEqual({
      previous_total: 4598.21,
      new_total: 5150,
      delta: 551.79,
    });

    // 4) Feed that EXACT persisted row back through the REAL portal read
    // path (quoteRowToPortalQuote, un-mocked) — the same function
    // loadPortalQuote calls — and confirm the card shows the SAME numbers
    // as the SMS above, not a reconstruction from TAXED.result.
    //
    // buildApproval's pendingAmendment branch only reads amendment.invoice_basis
    // (or the raw trail fields as fallback) — never row.result — so a real,
    // fully-shaped QuoteResult with the SAME totals TAXED.result carried is
    // built via calculateQuote (matching adapter.test.ts's own pattern)
    // rather than a hand-built partial object, which wouldn't satisfy the
    // QuoteResult type the adapter's line-item rendering expects.
    const zeroInputs: QuoteInputs = {
      santasFootage: 0,
      santasDifficulty: 'medium',
      gingerbreadFootage: 0,
      gingerbreadDifficulty: 'medium',
      winterWonderlandFootage: 0,
      winterWonderlandDifficulty: 'medium',
      stakeLightingFootage: 0,
      stakeLightingDifficulty: 'medium',
      miniLightItems: [],
      spritzers: [],
      wreaths: [],
      garland: [],
      takedown: 'included',
      rushFee: false,
    };
    const portalResult = {
      ...calculateQuote(zeroInputs),
      ...TAXED.result, // land on the SAME subtotal/tax/total the route actually used
    };
    const row: QuoteRowForPortal = {
      id: TAXED.id,
      customer_name: TAXED.customer_name,
      customer_address: null,
      customer_phone: null,
      customer_email: null,
      result: portalResult,
      inputs: null,
      total: portalResult.total,
      video_kind: null,
      video_src: null,
      video_poster: null,
      video_title: null,
      video_duration_sec: null,
      customer_approved_at: '2026-01-01T00:00:00Z',
      approval_snapshot: persistedSnapshot,
      deposit_paid_at: TAXED.deposit_paid_at,
      status: 'booked',
    };
    const portal = quoteRowToPortalQuote({ row, photos: PHOTOS });
    const pending = portal?.approval?.pendingAmendment;
    expect(pending).toBeDefined();
    expect(pending!.previousTotalUsd).toBe(4598.21);
    expect(pending!.newTotalUsd).toBe(5150);
    expect(pending!.deltaUsd).toBe(551.79);
    // Byte-for-byte agreement with what the SMS actually said, and with what
    // the invoice actually billed — the whole point of the fix.
    expect(usdText(pending!.newTotalUsd)).toBe(usdText(5150));
    expect(sms).toContain(usdText(pending!.newTotalUsd));
    expect(sms).toContain(usdText(pending!.deltaUsd));
    expect(pending!.newTotalUsd).toBe(sb.updates.invoices[0].total);
  });
});
