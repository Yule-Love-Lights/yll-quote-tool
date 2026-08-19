import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { AmendmentTrailEntry } from '@/lib/amend';

const { sbRef, getJobByQuoteMock, getInvoiceByJobMock, resyncInvoiceToAgreedTotalMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  getJobByQuoteMock: vi.fn(async (): Promise<unknown> => null),
  getInvoiceByJobMock: vi.fn(async (): Promise<unknown> => null),
  resyncInvoiceToAgreedTotalMock: vi.fn(async () => ({ invoicedBalance: null, invoicedTotal: null })),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));
// FIX2: the invoice re-sync's own DB reads/writes are covered by
// quoteAmendInvoiceSync's OWN unit tests + amend/route.test.ts (same shared
// function); this route's tests verify WHEN it's called and with what,
// mocking getJobByQuote/getInvoiceByJob (else the real implementations would
// hit this file's Supabase fake, which doesn't implement .maybeSingle()) and
// the resync call itself.
vi.mock('@/lib/jobs', () => ({ getJobByQuote: getJobByQuoteMock }));
vi.mock('@/lib/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/invoices')>();
  return { ...actual, getInvoiceByJob: getInvoiceByJobMock };
});
vi.mock('@/lib/quoteAmendInvoiceSync', () => ({ resyncInvoiceToAgreedTotal: resyncInvoiceToAgreedTotalMock }));

import { POST } from './route';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const AMENDED_AT = '2026-07-18T12:00:00.000Z';
const amendment: AmendmentTrailEntry = {
  amended_at: AMENDED_AT,
  by: 'staff:ops',
  reason: 'Added front wreaths',
  previous_total: 2000,
  new_total: 2400,
  previous_balance: 1000,
  new_balance: 1400,
  deposit_applied: 1000,
  delta: 400,
  line_item_changes: [],
  consent: { status: 'pending' },
};

const decreaseAmendment: AmendmentTrailEntry = {
  amended_at: AMENDED_AT,
  by: 'staff:ops',
  reason: 'Removed a spotlight',
  previous_total: 2400,
  new_total: 2000,
  previous_balance: 1400,
  new_balance: 1000,
  deposit_applied: 1000,
  delta: -400,
  line_item_changes: [],
  consent: { status: 'pending' },
};

const cosmeticAmendment: AmendmentTrailEntry = {
  amended_at: '2026-07-18T12:10:00.000Z',
  by: 'staff:ops',
  reason: 'Added free spritzers',
  previous_total: 2400,
  new_total: 2400,
  previous_balance: 1400,
  new_balance: 1400,
  deposit_applied: 1000,
  delta: 0,
  line_item_changes: [{ id: 'free-spritzers', label: 'Free spritzers', change: 'added', price: 0 }],
};

function makeSb(quote: Record<string, unknown>, updatedRows: unknown[] = [{ id: ID }]) {
  const updatePayloads: Array<Record<string, unknown>> = [];
  const eqCalls: Array<[string, unknown]> = [];
  const builder: Record<string, unknown> = {};
  let updating = false;
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    update: (payload: Record<string, unknown>) => {
      updating = true;
      updatePayloads.push(payload);
      return builder;
    },
    eq: (column: string, value: unknown) => {
      eqCalls.push([column, value]);
      return builder;
    },
    single: async () => ({ data: quote, error: null }),
    then: (resolve: (value: unknown) => void) => {
      const value = updating ? { data: updatedRows, error: null } : { data: quote, error: null };
      updating = false;
      resolve(value);
    },
  });
  return { client: builder, updatePayloads, eqCalls };
}

function req(body: Record<string, unknown>, headers: Record<string, string> = {}): NextRequest {
  return {
    json: async () => body,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

const bookedQuote = (snapshot: Record<string, unknown>) => ({
  id: ID,
  status: 'booked',
  quote_sent_at: '2026-06-20T00:00:00.000Z',
  customer_approved_at: '2026-06-25T00:00:00.000Z',
  deposit_paid_at: '2026-07-01T00:00:00.000Z',
  approval_snapshot: snapshot,
});

const ctx = { params: Promise.resolve({ id: ID }) };

beforeEach(() => vi.clearAllMocks());

describe('POST /api/quotes/[id]/amend-decline', () => {
  it('rejects a malformed capability token before reading the quote', async () => {
    const { client, updatePayloads } = makeSb({});
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), {
      params: Promise.resolve({ id: 'not-a-quote-id' }),
    });
    expect(res.status).toBe(400);
    expect(updatePayloads).toHaveLength(0);
  });

  it('rejects a missing amendedAt before writing', async () => {
    const { client, updatePayloads } = makeSb({});
    sbRef.current = client;
    const res = await POST(req({}), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad-decline');
    expect(updatePayloads).toHaveLength(0);
  });

  it('rejects an oversized reason before writing', async () => {
    const { client, updatePayloads } = makeSb({});
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT, reason: 'x'.repeat(501) }), ctx);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('bad-decline');
    expect(updatePayloads).toHaveLength(0);
  });

  it('atomically records a decline on the latest amendment, with no reason given', async () => {
    const originalSnapshot = { amendments: [amendment] };
    const { client, updatePayloads, eqCalls } = makeSb(bookedQuote(originalSnapshot));
    sbRef.current = client;

    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(eqCalls).toContainEqual(['approval_snapshot', JSON.stringify(originalSnapshot)]);
    const snapshot = updatePayloads[0].approval_snapshot as { amendments: AmendmentTrailEntry[] };
    expect(snapshot.amendments[0].consent).toMatchObject({ status: 'declined' });
    expect(snapshot.amendments[0].consent).not.toHaveProperty('reason');
    expect((snapshot.amendments[0].consent as { declined_at: string }).declined_at).toBeTruthy();
  });

  it('records an optional customer-typed reason, distinct from the staff amendment reason', async () => {
    const originalSnapshot = { amendments: [amendment] };
    const { client, updatePayloads } = makeSb(bookedQuote(originalSnapshot));
    sbRef.current = client;

    const res = await POST(
      req({ amendedAt: AMENDED_AT, reason: 'too expensive, please remove the wreath' }, {
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const snapshot = updatePayloads[0].approval_snapshot as { amendments: AmendmentTrailEntry[] };
    const consent = snapshot.amendments[0].consent as { status: string; reason?: string; ip: string | null };
    expect(consent.status).toBe('declined');
    expect(consent.reason).toBe('too expensive, please remove the wreath');
    expect(consent.ip).toBe('203.0.113.7');
    // The STAFF-facing amendment reason is untouched — the two are separate fields.
    expect(snapshot.amendments[0].reason).toBe('Added front wreaths');
  });

  it('declining a price DECREASE still records it (both directions need a response)', async () => {
    const originalSnapshot = { amendments: [decreaseAmendment] };
    const { client, updatePayloads } = makeSb(bookedQuote(originalSnapshot));
    sbRef.current = client;

    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(200);
    const snapshot = updatePayloads[0].approval_snapshot as { amendments: AmendmentTrailEntry[] };
    expect(snapshot.amendments[0].consent).toMatchObject({ status: 'declined' });
  });

  it('declines the pending price change while preserving a later cosmetic entry', async () => {
    const originalSnapshot = { amendments: [amendment, cosmeticAmendment] };
    const { client, updatePayloads, eqCalls } = makeSb(bookedQuote(originalSnapshot));
    sbRef.current = client;

    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(200);
    expect(eqCalls).toContainEqual(['approval_snapshot', JSON.stringify(originalSnapshot)]);
    const snapshot = updatePayloads[0].approval_snapshot as { amendments: AmendmentTrailEntry[] };
    expect(snapshot.amendments).toHaveLength(2);
    expect(snapshot.amendments[0].consent?.status).toBe('declined');
    expect(snapshot.amendments[1]).toEqual(cosmeticAmendment);
  });

  // NOTE: a cosmetic (zero-delta) "latest" amendment can't reach the
  // consent-not-required branch through this route's own lookup —
  // latestConsentAmendment already filters to requiresReconsent entries, so a
  // cosmetic-only trail returns null and hits stale-amendment instead. The
  // requiresReconsent recheck in route.ts is defensive/belt-and-suspenders
  // (mirrors amend-consent/route.ts's identical, identically-unreachable
  // check — that route's own test suite doesn't exercise it either).
  it('a cosmetic-only trail has no consent-requiring amendment to decline', async () => {
    const noopAmendment: AmendmentTrailEntry = { ...cosmeticAmendment, amended_at: AMENDED_AT };
    const { client, updatePayloads } = makeSb(bookedQuote({ amendments: [noopAmendment] }));
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('stale-amendment');
    expect(updatePayloads).toHaveLength(0);
  });

  it('rejects an outdated amendment id', async () => {
    const { client, updatePayloads } = makeSb(bookedQuote({ amendments: [amendment] }));
    sbRef.current = client;
    const res = await POST(req({ amendedAt: '2026-07-17T00:00:00.000Z' }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('stale-amendment');
    expect(updatePayloads).toHaveLength(0);
  });

  // Money-critical: declining an already-SIGNED amendment must never silently
  // discard the customer's real signature.
  it('refuses to decline an amendment the customer already accepted', async () => {
    const accepted: AmendmentTrailEntry = {
      ...amendment,
      consent: {
        status: 'accepted',
        accepted_at: '2026-07-18T13:00:00.000Z',
        signature: { name: 'Jordan Smith', kind: 'typed', value: 'Jordan Smith', signed_at: '2026-07-18T13:00:00.000Z', ip: null },
      },
    };
    const { client, updatePayloads } = makeSb(bookedQuote({ amendments: [accepted] }));
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('already-accepted');
    expect(updatePayloads).toHaveLength(0);
  });

  it('is idempotent: declining an already-declined amendment succeeds without a second write', async () => {
    const alreadyDeclined: AmendmentTrailEntry = {
      ...amendment,
      consent: { status: 'declined', declined_at: '2026-07-18T13:00:00.000Z', ip: null },
    };
    const { client, updatePayloads } = makeSb(bookedQuote({ amendments: [alreadyDeclined] }));
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.alreadyDeclined).toBe(true);
    expect(updatePayloads).toHaveLength(0);
  });

  it('rejects when the order is not a live booked order', async () => {
    const { client, updatePayloads } = makeSb({
      id: ID,
      status: 'cancelled',
      quote_sent_at: '2026-06-20T00:00:00.000Z',
      customer_approved_at: '2026-06-25T00:00:00.000Z',
      deposit_paid_at: null,
      approval_snapshot: { amendments: [amendment] },
    });
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('not-booked');
    expect(updatePayloads).toHaveLength(0);
  });

  it('fails a compare-and-swap race without overwriting consent', async () => {
    const { client } = makeSb(bookedQuote({ amendments: [amendment] }), []);
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('concurrent-amendment');
  });

  it('confirms a declined price increase still blocks settlement in its own response', async () => {
    const { client } = makeSb(bookedQuote({ amendments: [amendment] }));
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.stillBlocksSettlement).toBe(true);
  });

  it('confirms a declined price decrease does NOT block settlement in its own response', async () => {
    const { client } = makeSb(bookedQuote({ amendments: [decreaseAmendment] }));
    sbRef.current = client;
    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.stillBlocksSettlement).toBe(false);
  });
});

// FIX2 (review HIGH): before this fix, a decline never touched the invoice —
// on an already-invoiced order it stayed frozen at the rejected figures. The
// re-sync's OWN money math is covered by quoteAmendInvoiceSync (the shared
// function) via amend/route.test.ts's existing suite; these tests verify
// WHEN this route calls it and with what.
describe('POST /api/quotes/[id]/amend-decline — invoice re-sync (FIX2)', () => {
  const RESULT = { subtotalBeforeDiscount: 3200, discountAmount: 0, taxAmount: 0, total: 3200 };

  it('does not attempt a resync when the quote has no job at all', async () => {
    const { client } = makeSb({
      ...bookedQuote({ amendments: [amendment] }),
      result: RESULT,
      deposit_amount_usd: 1000,
    });
    sbRef.current = client;
    getJobByQuoteMock.mockResolvedValueOnce(null);

    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(200);
    expect(getInvoiceByJobMock).not.toHaveBeenCalled();
    expect(resyncInvoiceToAgreedTotalMock).not.toHaveBeenCalled();
  });

  it('does not attempt a resync when the job has no invoice yet', async () => {
    const { client } = makeSb({
      ...bookedQuote({ amendments: [amendment] }),
      result: RESULT,
      deposit_amount_usd: 1000,
    });
    sbRef.current = client;
    getJobByQuoteMock.mockResolvedValueOnce({ id: 'job-1' });
    getInvoiceByJobMock.mockResolvedValueOnce(null);

    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(200);
    expect(resyncInvoiceToAgreedTotalMock).not.toHaveBeenCalled();
  });

  it('skips a CANCELLED invoice (never resurrects it)', async () => {
    const { client } = makeSb({
      ...bookedQuote({ amendments: [amendment] }),
      result: RESULT,
      deposit_amount_usd: 1000,
    });
    sbRef.current = client;
    getJobByQuoteMock.mockResolvedValueOnce({ id: 'job-1' });
    getInvoiceByJobMock.mockResolvedValueOnce({ id: 'inv-1', status: 'cancelled' });

    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(200);
    expect(resyncInvoiceToAgreedTotalMock).not.toHaveBeenCalled();
  });

  it('re-syncs to the now-effective (post-decline) agreed total — falls back to the prior selection', async () => {
    // customerSelection $2,000 (the original approval); the sole amendment
    // proposed $2,400 and IS declined here. Post-decline, resolveAgreedTotal
    // skips the declined entry (FIX1) and lands back on the $2,000 selection —
    // NOT the $2,400 the customer just refused.
    const snapshot = { customerSelection: { currentTotalUsd: 2000 }, amendments: [amendment] };
    const { client } = makeSb({ ...bookedQuote(snapshot), result: RESULT, deposit_amount_usd: 1000 });
    sbRef.current = client;
    getJobByQuoteMock.mockResolvedValueOnce({ id: 'job-1' });
    const invoiceRow = { id: 'inv-1', status: 'awaiting_payment', tax_overridden: false };
    getInvoiceByJobMock.mockResolvedValueOnce(invoiceRow);

    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(200);
    expect(resyncInvoiceToAgreedTotalMock).toHaveBeenCalledTimes(1);
    expect(resyncInvoiceToAgreedTotalMock).toHaveBeenCalledWith({
      jobId: 'job-1',
      invoice: invoiceRow,
      result: RESULT,
      depositPaid: 1000,
      newTotal: 2000,
      logPrefix: '[api/quotes/:id/amend-decline]',
      retiredReason: 'amend-decline-reopen',
    });
  });

  it('re-syncs to an earlier ACCEPTED amendment when the latest (declined) one is skipped', async () => {
    const acceptedFirst: AmendmentTrailEntry = {
      ...amendment,
      amended_at: '2026-07-10T00:00:00.000Z',
      new_total: 2400,
      consent: { status: 'accepted', accepted_at: '2026-07-10T01:00:00.000Z', signature: { name: 'Jordan', kind: 'typed', value: 'Jordan', signed_at: '2026-07-10T01:00:00.000Z', ip: null } },
    };
    const declinedSecond: AmendmentTrailEntry = {
      ...amendment,
      amended_at: AMENDED_AT,
      previous_total: 2400,
      new_total: 2900,
      delta: 500,
    };
    const snapshot = { amendments: [acceptedFirst, declinedSecond] };
    const { client } = makeSb({ ...bookedQuote(snapshot), result: RESULT, deposit_amount_usd: 1000 });
    sbRef.current = client;
    getJobByQuoteMock.mockResolvedValueOnce({ id: 'job-1' });
    const invoiceRow = { id: 'inv-1', status: 'awaiting_payment', tax_overridden: false };
    getInvoiceByJobMock.mockResolvedValueOnce(invoiceRow);

    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(200);
    expect(resyncInvoiceToAgreedTotalMock).toHaveBeenCalledWith(
      expect.objectContaining({ newTotal: 2400 }), // the earlier accepted amendment, not the declined $2,900
    );
  });

  it('does not attempt a resync for the idempotent already-declined short-circuit', async () => {
    const alreadyDeclined: AmendmentTrailEntry = {
      ...amendment,
      consent: { status: 'declined', declined_at: '2026-07-18T13:00:00.000Z', ip: null },
    };
    const { client } = makeSb({
      ...bookedQuote({ amendments: [alreadyDeclined] }),
      result: RESULT,
      deposit_amount_usd: 1000,
    });
    sbRef.current = client;

    const res = await POST(req({ amendedAt: AMENDED_AT }), ctx);
    expect(res.status).toBe(200);
    expect(getJobByQuoteMock).not.toHaveBeenCalled();
    expect(resyncInvoiceToAgreedTotalMock).not.toHaveBeenCalled();
  });
});
