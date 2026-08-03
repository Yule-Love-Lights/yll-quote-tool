// Tests for POST /api/quotes/[id]/pay-balance (#83 pay-link). Customer-facing
// (gated by the quote UUID, not operator auth); reuses createHostedPageSale.
// Valor, Supabase, jobs/invoices, and the rate limiter are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { type NextRequest } from 'next/server';

const {
  sbRef,
  createHostedPageSaleMock,
  isValorConfiguredMock,
  getJobByQuoteMock,
  getInvoiceByJobMock,
  rateLimitMock,
} = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  createHostedPageSaleMock: vi.fn(async () => ({ url: 'https://valor.example/pay', uid: 'u1', raw: {} })),
  isValorConfiguredMock: vi.fn(() => true),
  getJobByQuoteMock: vi.fn(async (): Promise<unknown> => ({ id: 'job-1' })),
  getInvoiceByJobMock: vi.fn(async (): Promise<unknown> => ({ id: 'inv-1', status: 'awaiting_payment', balance: 2500 })),
  rateLimitMock: vi.fn((): unknown => null),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: rateLimitMock }));
vi.mock('@/lib/integrations/valor', () => ({
  createHostedPageSale: createHostedPageSaleMock,
  isValorConfigured: isValorConfiguredMock,
  ValorError: class ValorError extends Error {},
}));
vi.mock('@/lib/jobs', () => ({ getJobByQuote: getJobByQuoteMock }));
vi.mock('@/lib/invoices', () => ({ getInvoiceByJob: getInvoiceByJobMock }));

import { POST } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const req = () => ({ nextUrl: { origin: 'https://portal.test' } }) as unknown as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

type Row = Record<string, unknown>;
// #187c: a second read (`.select('view_only').eq('id', id).maybeSingle()`)
// fires right before the Valor call as a TOCTOU re-check. `single()` stays
// the FIRST fetch's terminal (unchanged); `maybeSingle()` is the re-check's
// terminal — defaults to mirroring the same row's view_only, unless
// `opts.recheckViewOnly` overrides it to simulate a flip mid-request, or
// `opts.recheckDeleted` (#187 review FIX 3, #660) forces `data: null` to
// simulate the row being deleted BETWEEN the first fetch and the re-check
// (the first fetch still succeeds normally with `quote`).
function makeSb(quote: Row | null, opts: { recheckViewOnly?: boolean; recheckDeleted?: boolean } = {}) {
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: () => b,
    select: () => b,
    eq: () => b,
    single: async () => ({ data: quote, error: quote ? null : { message: 'no rows' } }),
    maybeSingle: async () => ({
      data: quote && !opts.recheckDeleted ? { view_only: opts.recheckViewOnly ?? quote.view_only } : null,
      error: null,
    }),
  });
  return b;
}

const QUOTE = { id: ID, customer_name: 'Alice', customer_email: 'a@x.com', is_test: false, view_only: false };

beforeEach(() => {
  vi.clearAllMocks();
  isValorConfiguredMock.mockReturnValue(true);
  rateLimitMock.mockReturnValue(null);
  getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
  getInvoiceByJobMock.mockResolvedValue({ id: 'inv-1', status: 'awaiting_payment', balance: 2500 });
  sbRef.current = makeSb(QUOTE);
});

describe('POST /api/quotes/[id]/pay-balance', () => {
  it('503s when Valor is not configured', async () => {
    isValorConfiguredMock.mockReturnValueOnce(false);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(503);
  });

  it('400s on an invalid quote id', async () => {
    const res = await POST(req(), ctx('nope'));
    expect(res.status).toBe(400);
  });

  it('404s when the quote is missing', async () => {
    sbRef.current = makeSb(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
  });

  it('400s for a test quote (never touches real Valor)', async () => {
    sbRef.current = makeSb({ ...QUOTE, is_test: true });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('test-quote');
    expect(createHostedPageSaleMock).not.toHaveBeenCalled();
  });

  // #176 — a staff-flagged browse-only quote must never mint a real hosted
  // page, checked before any invoice lookup or Valor call.
  it('409s (view-only) when the quote is flagged view-only', async () => {
    sbRef.current = makeSb({ ...QUOTE, view_only: true });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('view-only');
    expect(getInvoiceByJobMock).not.toHaveBeenCalled();
    expect(createHostedPageSaleMock).not.toHaveBeenCalled();
  });

  // #187c belt-and-suspenders — a cheap re-read right before the Valor call
  // catches a flip that lands after the fast-path check but before checkout.
  it('409s (view-only) when the flag flips ON between the fast-path check and the Valor call', async () => {
    sbRef.current = makeSb({ ...QUOTE, view_only: false }, { recheckViewOnly: true });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('view-only');
    expect(createHostedPageSaleMock).not.toHaveBeenCalled();
  });

  // #187 review FIX 3 (#660): the re-check must fail CLOSED, not open, when
  // the quote row is gone by the time of the re-check — `recheck?.view_only`
  // is equally falsy for "row exists, unflagged" and "row doesn't exist",
  // so a deleted quote must 404 rather than silently proceed to Valor.
  it('404s when the quote row is gone by the time of the pre-Valor re-check', async () => {
    sbRef.current = makeSb({ ...QUOTE }, { recheckDeleted: true });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.error).toMatch(/not found/i);
    expect(createHostedPageSaleMock).not.toHaveBeenCalled();
  });

  it('409s when there is no invoice yet', async () => {
    getInvoiceByJobMock.mockResolvedValueOnce(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
  });

  it('409s when there is no balance due (already paid)', async () => {
    getInvoiceByJobMock.mockResolvedValueOnce({ id: 'inv-1', status: 'paid', balance: 0 });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('no-balance');
  });

  it('starts a hosted-page sale for the balance with a bal_ order ref', async () => {
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, redirectUrl: 'https://valor.example/pay', amountUsd: 2500 });
    expect(createHostedPageSaleMock).toHaveBeenCalledWith(
      expect.objectContaining({ amountUsd: 2500, orderRef: `bal_${ID}` }),
    );
  });

  it('sends a balance-specific successUrl so the approved page confirms payment, not "still owed"', async () => {
    await POST(req(), ctx());
    expect(createHostedPageSaleMock).toHaveBeenCalledWith(
      expect.objectContaining({ successUrl: `https://portal.test/portal/${ID}/approved?balance=paid` }),
    );
  });
});
