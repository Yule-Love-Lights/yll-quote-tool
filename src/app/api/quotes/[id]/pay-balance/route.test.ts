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
  notifyTelegramAudienceMock,
} = vi.hoisted(() => ({
  notifyTelegramAudienceMock: vi.fn(async (_audience: string, _text: string) => {}),
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
vi.mock('@/lib/invoices', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getInvoiceByJob: getInvoiceByJobMock,
}));
vi.mock('@/lib/integrations/telegramRouting', () => ({
  notifyTelegramAudience: notifyTelegramAudienceMock,
}));

import { POST } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const req = () => ({ nextUrl: { origin: 'https://portal.test' } }) as unknown as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

type Row = Record<string, unknown>;
// #187c: a second read (`.select('view_only, is_nce').eq('id', id).maybeSingle()`)
// fires right before the Valor call as a TOCTOU re-check. `single()` stays
// the FIRST fetch's terminal (unchanged); `maybeSingle()` is the re-check's
// terminal — defaults to mirroring the same row's view_only/is_nce, unless
// `opts.recheckViewOnly`/`opts.recheckIsNce` override it to simulate a flip
// mid-request, or `opts.recheckDeleted` (#187 review FIX 3, #660) forces
// `data: null` to simulate the row being deleted BETWEEN the first fetch and
// the re-check (the first fetch still succeeds normally with `quote`).
//
// Row 378 fix round: the guard's refusal path also reads the quote's
// approval_snapshot and CASes a `paymentBlocked` marker onto it, so the builder
// now records the columns each `.select()` asked for. `maybeSingle()` serves the
// SNAPSHOT row when the caller selected `approval_snapshot`, and the view_only/
// is_nce re-check row otherwise — without that the marker read would silently
// receive the re-check shape and every snapshot assertion below would be
// meaningless. `update()` returns its own chainable so the main builder never
// has to be thenable (which would make any stray `await` on a partial chain
// resolve to something).
function makeSb(
  quote: Row | null,
  opts: {
    recheckViewOnly?: boolean;
    recheckIsNce?: boolean;
    recheckDeleted?: boolean;
    /** The quote's stored approval_snapshot, as the marker read sees it. */
    snapshot?: Record<string, unknown> | null;
    /** Force the marker's CAS write to report a lost race (0 rows updated). */
    snapshotCasLost?: boolean;
  } = {},
) {
  const b: Record<string, unknown> = {};
  const updates: Record<string, unknown>[] = [];
  const upd: Record<string, unknown> = {};
  Object.assign(upd, {
    eq: () => upd,
    select: async () => ({ data: opts.snapshotCasLost ? [] : [{ id: 'q1' }], error: null }),
  });
  let lastSelect = '';
  Object.assign(b, {
    __updates: updates,
    from: () => b,
    select: (cols?: string) => {
      lastSelect = cols ?? '';
      return b;
    },
    eq: () => b,
    update: (payload: Record<string, unknown>) => {
      updates.push(payload);
      return upd;
    },
    single: async () => ({ data: quote, error: quote ? null : { message: 'no rows' } }),
    maybeSingle: async () => {
      if (lastSelect.includes('approval_snapshot')) {
        return { data: { approval_snapshot: opts.snapshot ?? null }, error: null };
      }
      return {
        data:
          quote && !opts.recheckDeleted
            ? { view_only: opts.recheckViewOnly ?? quote.view_only, is_nce: opts.recheckIsNce ?? quote.is_nce ?? false }
            : null,
        error: null,
      };
    },
  });
  return b;
}

/** The approval_snapshot payloads the route CASed during a request. */
function markerWrites(sb: unknown): Record<string, unknown>[] {
  return ((sb as { __updates: Record<string, unknown>[] }).__updates ?? []).filter(
    (u) => 'approval_snapshot' in u,
  );
}

const QUOTE = { id: ID, customer_name: 'Alice', customer_email: 'a@x.com', is_test: false, view_only: false, is_nce: false };

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

  // #199 — an NCE trade job's balance is never collectable here (it settles
  // through NCE), checked before any invoice lookup or Valor call.
  it('409s (nce) when the quote is NCE-tagged', async () => {
    sbRef.current = makeSb({ ...QUOTE, is_nce: true });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('nce');
    expect(getInvoiceByJobMock).not.toHaveBeenCalled();
    expect(createHostedPageSaleMock).not.toHaveBeenCalled();
  });

  // #187c parity for #199 — the same pre-Valor re-check catches an NCE flip too.
  it('409s (nce) when the flag flips ON between the fast-path check and the Valor call', async () => {
    sbRef.current = makeSb({ ...QUOTE, is_nce: false }, { recheckIsNce: true });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('nce');
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

  // ---- Row 378: the reconciliation guard (customer mirror of charge-balance) ----
  //
  // Fixtures are hand-computed against the REAL formula so the assertions stay
  // independent of it (asserting whatever computeInvoiceResyncTotals returns
  // would be circular). With result.total 2000, deposit 1000 and an invoice at
  // total 2000 / deposit_applied 1000 / balance 1000, priorBalanceCollectedUsd
  // is 2000-1000-1000 = 0 and the expected balance is 2000-1000 = 1000, so the
  // untouched case reconciles exactly. An amendment to 2400 that never reached
  // the invoice moves the expected balance to 2400-1000 = 1400 while the row
  // still says 1000: a $400 under-collection if it were charged as-is.
  const PRICED = { total: 2000, taxAmount: 0, subtotalBeforeDiscount: 2000, discountAmount: 0 };
  const INVOICE_IN_SYNC = {
    id: 'inv-1',
    status: 'awaiting_payment',
    balance: 1000,
    total: 2000,
    deposit_applied: 1000,
    tax_overridden: false,
  };
  const PRICED_QUOTE = {
    ...QUOTE,
    result: PRICED,
    deposit_amount_usd: 1000,
    approval_snapshot: { customerSelection: { currentTotalUsd: 2000 } },
  };
  const AMENDED = (status: string) => ({
    ...PRICED_QUOTE,
    approval_snapshot: {
      customerSelection: { currentTotalUsd: 2000 },
      amendments: [{ new_total: 2400, consent: { status } }],
    },
  });

  it('charges normally when the invoice still reconciles with the agreed total (no false positive)', async () => {
    sbRef.current = makeSb(PRICED_QUOTE);
    getInvoiceByJobMock.mockResolvedValue(INVOICE_IN_SYNC);
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.amountUsd).toBe(1000);
    expect(createHostedPageSaleMock).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: 1000 }));
    expect(notifyTelegramAudienceMock).not.toHaveBeenCalled();
  });

  it('409s (invoice-stale) rather than charge a balance an amendment left behind', async () => {
    sbRef.current = makeSb(AMENDED('accepted'));
    getInvoiceByJobMock.mockResolvedValue(INVOICE_IN_SYNC);
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('invoice-stale');
    // The whole point: no charge is opened at Valor for the stale $1000.
    expect(createHostedPageSaleMock).not.toHaveBeenCalled();
    // ...and the customer-facing text leaks neither figure nor the mechanism.
    expect(json.error).not.toMatch(/1000|1400|amend|sync|stale/i);
  });

  it('pings staff with BOTH figures when it refuses, so the refusal is not a dead end', async () => {
    sbRef.current = makeSb(AMENDED('accepted'));
    getInvoiceByJobMock.mockResolvedValue(INVOICE_IN_SYNC);
    await POST(req(), ctx());
    expect(notifyTelegramAudienceMock).toHaveBeenCalledTimes(1);
    const [audience, text] = notifyTelegramAudienceMock.mock.calls[0];
    expect(audience).toBe('jobs');
    // Both figures, formatted to cents — a bare `$1000` reads as an odd number
    // next to every other money figure staff see in these alerts.
    expect(text).toContain('$1000.00');
    expect(text).toContain('$1400.00');
    // A clickable order link, not a bare UUID an office person cannot act on
    // (this repo's convention for every other staff "needs attention" alert).
    expect(text).toContain('https://portal.test/admin/invoices/inv-1');
    // ...and the remedy names the path that actually works today.
    expect(text).toMatch(/Record amendment/i);
  });

  it('records a durable paymentBlocked marker so the block survives a dormant bot', async () => {
    const sb = makeSb(AMENDED('accepted'), { snapshot: { customerSelection: { currentTotalUsd: 2000 } } });
    sbRef.current = sb;
    getInvoiceByJobMock.mockResolvedValue(INVOICE_IN_SYNC);
    await POST(req(), ctx());
    const writes = markerWrites(sb);
    expect(writes).toHaveLength(1);
    const snap = writes[0].approval_snapshot as Record<string, unknown>;
    const blocked = snap.paymentBlocked as Record<string, unknown>;
    expect(blocked).toMatchObject({ invoiceId: 'inv-1', storedBalance: 1000, expectedBalance: 1400 });
    expect(typeof blocked.at).toBe('string');
    // The pre-existing snapshot content must survive the marker write — this
    // column carries the customer's agreed money basis.
    expect(snap.customerSelection).toEqual({ currentTotalUsd: 2000 });
  });

  it('does not page staff twice for the same order inside the cooldown', async () => {
    sbRef.current = makeSb(AMENDED('accepted'), {
      snapshot: { paymentBlocked: { at: new Date().toISOString() } },
    });
    getInvoiceByJobMock.mockResolvedValue(INVOICE_IN_SYNC);
    const res = await POST(req(), ctx());
    // Still refused — the cooldown suppresses the ALERT, never the guard.
    expect(res.status).toBe(409);
    expect(createHostedPageSaleMock).not.toHaveBeenCalled();
    expect(notifyTelegramAudienceMock).not.toHaveBeenCalled();
  });

  it('pings again once the cooldown has expired', async () => {
    sbRef.current = makeSb(AMENDED('accepted'), {
      snapshot: { paymentBlocked: { at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() } },
    });
    getInvoiceByJobMock.mockResolvedValue(INVOICE_IN_SYNC);
    await POST(req(), ctx());
    expect(notifyTelegramAudienceMock).toHaveBeenCalledTimes(1);
  });

  // The marker is best-effort forensics; the customer's refusal is not. A lost
  // CAS race (a concurrent amend wrote the snapshot in the gap) must drop the
  // marker without retrying, blind-overwriting, or changing the response.
  it('still refuses cleanly when the marker write loses its CAS race', async () => {
    sbRef.current = makeSb(AMENDED('accepted'), { snapshot: {}, snapshotCasLost: true });
    getInvoiceByJobMock.mockResolvedValue(INVOICE_IN_SYNC);
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('invoice-stale');
    expect(createHostedPageSaleMock).not.toHaveBeenCalled();
  });

  // A DECLINED amendment is a price the customer refused, so it must NOT become
  // the agreed total, otherwise every decline would block that customer's
  // perfectly valid payment forever. resolveAgreedTotal skips it; this pins that
  // the guard inherits the skip rather than re-deriving its own precedence.
  it('does not refuse over an amendment the customer DECLINED', async () => {
    sbRef.current = makeSb(AMENDED('declined'));
    getInvoiceByJobMock.mockResolvedValue(INVOICE_IN_SYNC);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(createHostedPageSaleMock).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: 1000 }));
  });

  // The permissive default every other quote-gated check in this route takes:
  // with no priced result there is nothing to reconcile against, so the guard
  // stands aside rather than blocking a legacy row from paying.
  it('skips the guard entirely when the quote has no priced result', async () => {
    sbRef.current = makeSb({ ...QUOTE, result: null, deposit_amount_usd: 1000, approval_snapshot: null });
    getInvoiceByJobMock.mockResolvedValue(INVOICE_IN_SYNC);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(200);
    expect(notifyTelegramAudienceMock).not.toHaveBeenCalled();
  });

  // The row we validate must be the row we charge: the pre-Valor re-read means
  // a balance that moved UPWARD mid-request is collected in full, instead of
  // silently under-collecting the figure read at the top of the request (#173's
  // window, which charge-balance closes for staff and this closes for customers).
  it('charges the FRESH balance when the invoice moves between the two reads', async () => {
    sbRef.current = makeSb(QUOTE);
    getInvoiceByJobMock
      .mockResolvedValueOnce({ ...INVOICE_IN_SYNC, balance: 1000 })
      .mockResolvedValueOnce({ ...INVOICE_IN_SYNC, balance: 1400 });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.amountUsd).toBe(1400);
    expect(createHostedPageSaleMock).toHaveBeenCalledWith(expect.objectContaining({ amountUsd: 1400 }));
  });

  // Fail CLOSED, never fall through to the stale figure read at the top.
  it('409s rather than charge the stale figure when the invoice vanishes on the re-read', async () => {
    sbRef.current = makeSb(QUOTE);
    getInvoiceByJobMock.mockResolvedValueOnce(INVOICE_IN_SYNC).mockResolvedValueOnce(null);
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('no-invoice');
    expect(createHostedPageSaleMock).not.toHaveBeenCalled();
  });

  it('409s rather than charge when the invoice is settled between the two reads', async () => {
    sbRef.current = makeSb(QUOTE);
    getInvoiceByJobMock
      .mockResolvedValueOnce(INVOICE_IN_SYNC)
      .mockResolvedValueOnce({ ...INVOICE_IN_SYNC, status: 'paid', balance: 0 });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('no-balance');
    expect(createHostedPageSaleMock).not.toHaveBeenCalled();
  });
});
