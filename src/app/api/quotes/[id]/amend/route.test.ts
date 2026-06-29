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

const BOOKED_QUOTE = {
  id: ID,
  status: 'booked',
  deposit_amount_usd: 2500,
  deposit_paid_at: '2026-01-01T00:00:00Z',
  result: { subtotalBeforeDiscount: 5600, discountAmount: 0, taxAmount: 0, total: 5600 },
  approval_snapshot: { customerSelection: { currentTotalUsd: 5000 }, amendments: [] },
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

  it('reopens an already-PAID invoice to awaiting_payment when amended up', async () => {
    const sb = makeSb(BOOKED_QUOTE);
    sbRef.current = sb.client;
    getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
    getInvoiceByJobMock.mockResolvedValue({ id: 'inv-1', balance: 0, status: 'paid', tax_overridden: false });

    const res = await POST(req({ reason: 'added an extra wreath' }), ctx());
    expect(res.status).toBe(200);
    expect(sb.updates.invoices[0]).toMatchObject({ balance: 3100, status: 'awaiting_payment' });
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
});
