import { describe, it, expect, beforeEach, vi } from 'vitest';
import { type NextRequest } from 'next/server';

// Row 388 — the standalone resync action. This route's own job is thin:
// auth, load the invoice + linked quote, resolve the agreed total, and call
// the SHARED resyncInvoiceToAgreedTotal with the right arguments — the money
// math and the CAS/retry semantics are that function's own, already covered
// by quoteAmendInvoiceSync.test.ts and the /amend + /amend-decline route
// tests. These tests verify WHEN this route calls it, WITH what, and how it
// maps the outcome to a response — mirroring amend-decline/route.test.ts's
// mocking shape for the same shared call.
//
// Row 990 fix round (admin lens HIGH + staff MED x2) added three more things
// this route's own tests need to cover directly (none of them delegate to
// resyncInvoiceToAgreedTotal, which stays fully mocked here):
//   FIX 2 — refuse a 'paid' invoice before ever calling the resync.
//   FIX 3 — pre-compare against computeInvoiceResyncTotals (the REAL, un-mocked
//           function) and skip the write when nothing would change.
//   FIX 1 — append a durable audit entry AFTER a successful resync, using a
//           FRESH re-read of approval_snapshot (resyncInvoiceToAgreedTotal's
//           own success path mutates it — clearing stale markers — so the
//           pre-resync read is stale by the time this route would use it as
//           a CAS base). The fake below models the REAL CAS semantics
//           (mirroring mark-reconciled/route.test.ts's fixture, the S51
//           "concurrency has to be IN the fixture" lesson) so the audit tests
//           exercise the real appendQuoteAuditEntry/casSwapApprovalSnapshot
//           code, not a mock that can't lose a race.

const {
  sbRef,
  requireOperatorMock,
  getOperatorMock,
  getInvoiceMock,
  getJobByQuoteMock,
  resyncInvoiceToAgreedTotalMock,
} = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async (): Promise<unknown> => ({ id: 'op-1', email: 'jason@yulelovelights.com' })),
  getInvoiceMock: vi.fn(async (): Promise<unknown> => null),
  getJobByQuoteMock: vi.fn(async (): Promise<unknown> => null),
  resyncInvoiceToAgreedTotalMock: vi.fn(async () => ({
    invoicedBalance: 1500 as number | null,
    invoicedTotal: 2500 as number | null,
    previousInvoicedTotal: 2000 as number | null,
    resynced: true,
  })),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));
vi.mock('@/lib/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/invoices')>();
  return { ...actual, getInvoice: getInvoiceMock };
});
vi.mock('@/lib/jobs', () => ({ getJobByQuote: getJobByQuoteMock }));
// resyncInvoiceToAgreedTotal itself is mocked (its own money/CAS semantics
// are covered elsewhere) — computeInvoiceResyncTotals and
// priorBalanceCollectedUsd are DELIBERATELY left real, since FIX 3's
// pre-compare depends on them producing the actual formula's numbers.
vi.mock('@/lib/quoteAmendInvoiceSync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/quoteAmendInvoiceSync')>();
  return { ...actual, resyncInvoiceToAgreedTotal: resyncInvoiceToAgreedTotalMock };
});

import { POST } from './route';

const INVOICE_ID = '22222222-2222-4222-8222-222222222222';
const QUOTE_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';

const RESULT = { total: 2500 } as unknown;

type QuoteFixture = { result: unknown; approval_snapshot: unknown; deposit_amount_usd: number | null };

// A real CAS-aware fake for the `quotes` table — mirrors
// mark-reconciled/route.test.ts's fixture. Supports:
//   - the route's initial `.select('result, approval_snapshot, deposit_amount_usd')`
//   - the FIX 1 fresh `.select('approval_snapshot')` re-read after a successful resync
//   - the FIX 1 audit `.update({approval_snapshot})` CAS write (+ appendQuoteAuditEntry's
//     one re-read-and-retry on a lost race)
// `state.snapshot` is the single source of truth every select/update reads
// from and writes to, so a test can mutate it BETWEEN reads (simulating
// resyncInvoiceToAgreedTotal's own clear) or force every update to lose its
// CAS (simulating a persistent concurrent writer).
function makeFakeQuotes(
  row: QuoteFixture | null,
  opts: { readFails?: boolean; failReadOnCall?: number; updateAlwaysConflicts?: boolean; updateErrors?: boolean } = {},
) {
  const state = { snapshot: row?.approval_snapshot ?? null };
  const updates: Array<Record<string, unknown>> = [];
  let reads = 0;
  function from(table: string) {
    expect(table).toBe('quotes');
    const q = { op: 'select' as 'select' | 'update', payload: null as Record<string, unknown> | null, casMatch: true };
    const b = {
      select: () => b,
      update(payload: Record<string, unknown>) {
        q.op = 'update';
        q.payload = payload;
        return b;
      },
      eq(col: string, val: unknown) {
        if (col === 'approval_snapshot') {
          q.casMatch = !opts.updateAlwaysConflicts && typeof val === 'string' && JSON.stringify(state.snapshot) === val;
        }
        return b;
      },
      async maybeSingle() {
        reads += 1;
        if (opts.readFails || opts.failReadOnCall === reads) {
          return { data: null, error: { message: 'connection reset' } };
        }
        if (!row) return { data: null, error: null };
        return {
          data: { result: row.result, approval_snapshot: state.snapshot, deposit_amount_usd: row.deposit_amount_usd },
          error: null,
        };
      },
      then(resolve: (v: unknown) => void) {
        if (q.op !== 'update') return resolve({ data: [], error: null });
        if (opts.updateErrors) return resolve({ data: null, error: { message: 'write failed' } });
        if (row && q.casMatch) {
          updates.push(q.payload!);
          state.snapshot = (q.payload as { approval_snapshot: unknown }).approval_snapshot as
            | Record<string, unknown>
            | null;
          return resolve({ data: [{ id: QUOTE_ID }], error: null });
        }
        return resolve({ data: [], error: null });
      },
    };
    return b;
  }
  return { client: { from }, updates, state };
}

const req = () => ({}) as unknown as NextRequest;
const params = { params: Promise.resolve({ id: INVOICE_ID }) };

// A default invoice whose stored money fields DELIBERATELY do NOT match what
// the default quote fixture (RESULT total 2500, agreed total 2500, deposit
// 1000) would resync to (planned subtotal/discount/tax/total/balance =
// 0/0/0/2500/1500 per computeInvoiceResyncTotals) — so FIX 3's pre-compare
// resolves `unchanged: false` and every "happy path" test below still
// exercises the real resyncInvoiceToAgreedTotal call, exactly like before
// the fix round. The dedicated changed:false test overrides these to match.
const DEFAULT_INVOICE = {
  id: INVOICE_ID,
  quote_id: QUOTE_ID,
  status: 'awaiting_payment' as const,
  subtotal: 2000,
  discount: 0,
  tax: 0,
  total: 2000,
  deposit_applied: 1000,
  balance: 1000,
  credit_note: 0,
  tax_overridden: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue({ id: 'op-1', email: 'jason@yulelovelights.com' });
  getInvoiceMock.mockResolvedValue({ ...DEFAULT_INVOICE });
  getJobByQuoteMock.mockResolvedValue({ id: JOB_ID });
  resyncInvoiceToAgreedTotalMock.mockResolvedValue({
    invoicedBalance: 1500,
    invoicedTotal: 2500,
    previousInvoicedTotal: 2000,
    resynced: true,
  });
  sbRef.current = makeFakeQuotes({
    result: RESULT,
    approval_snapshot: { customerSelection: { currentTotalUsd: 2500 } },
    deposit_amount_usd: 1000,
  }).client;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('POST /api/invoices/[id]/resync (row 388)', () => {
  it('calls resyncInvoiceToAgreedTotal with the resolved agreed total + the linked job id, and returns the outcome', async () => {
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, invoicedTotal: 2500, invoicedBalance: 1500, previousInvoicedTotal: 2000, audited: true });
    expect(resyncInvoiceToAgreedTotalMock).toHaveBeenCalledWith({
      jobId: JOB_ID,
      invoice: { ...DEFAULT_INVOICE },
      result: RESULT,
      depositPaid: 1000,
      newTotal: 2500,
      logPrefix: '[api/invoices/:id/resync]',
      retiredReason: 'manual-resync',
    });
  });

  it('resolves the agreed total from the LATEST non-declined amendment, not the raw result total', async () => {
    sbRef.current = makeFakeQuotes({
      result: { total: 3000 },
      approval_snapshot: { amendments: [{ new_total: 2700 }] },
      deposit_amount_usd: 1000,
    }).client;
    await POST(req(), params);
    expect(resyncInvoiceToAgreedTotalMock).toHaveBeenCalledWith(
      expect.objectContaining({ newTotal: 2700 }),
    );
  });

  it('passes jobId:null when the quote has no linked job (no fresh re-read possible, matching /amend-decline)', async () => {
    getJobByQuoteMock.mockResolvedValue(null);
    await POST(req(), params);
    expect(resyncInvoiceToAgreedTotalMock).toHaveBeenCalledWith(expect.objectContaining({ jobId: null }));
  });

  it('409s resync-failed and does NOT report ok:true when resyncInvoiceToAgreedTotal reports resynced:false', async () => {
    resyncInvoiceToAgreedTotalMock.mockResolvedValue({
      invoicedBalance: null,
      invoicedTotal: null,
      previousInvoicedTotal: null,
      resynced: false,
    });
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('resync-failed');
  });

  it('409s cancelled for a cancelled invoice, without calling the resync at all', async () => {
    getInvoiceMock.mockResolvedValue({ ...DEFAULT_INVOICE, status: 'cancelled' });
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('cancelled');
    expect(resyncInvoiceToAgreedTotalMock).not.toHaveBeenCalled();
  });

  it('409s no-quote for an invoice with no linked order', async () => {
    getInvoiceMock.mockResolvedValue({ ...DEFAULT_INVOICE, quote_id: null });
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no-quote');
  });

  it('409s no-pricing when the linked quote has no priced result', async () => {
    sbRef.current = makeFakeQuotes({ result: null, approval_snapshot: null, deposit_amount_usd: null }).client;
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no-pricing');
    expect(resyncInvoiceToAgreedTotalMock).not.toHaveBeenCalled();
  });

  it('503s read-failed when the quote read fails, and writes nothing', async () => {
    sbRef.current = makeFakeQuotes(null).client;
    const res = await POST(req(), params);
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('read-failed');
    expect(resyncInvoiceToAgreedTotalMock).not.toHaveBeenCalled();
  });

  it('404s an unknown invoice and 400s a malformed id', async () => {
    getInvoiceMock.mockResolvedValue(null);
    expect((await POST(req(), params)).status).toBe(404);
    expect((await POST(req(), { params: Promise.resolve({ id: 'not-a-uuid' }) })).status).toBe(400);
  });

  it('denies a non-operator before touching the invoice at all', async () => {
    const { NextResponse } = await import('next/server');
    requireOperatorMock.mockResolvedValue(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const res = await POST(req(), params);
    expect(res.status).toBe(401);
    expect(getInvoiceMock).not.toHaveBeenCalled();
  });

  // ─── FIX 2 (admin lens HIGH part b + staff MED 2): refuse a settled invoice ──

  describe('FIX 2 — refuse a paid invoice', () => {
    it("409s 'paid' for an already-settled invoice, before ever calling the resync", async () => {
      getInvoiceMock.mockResolvedValue({ ...DEFAULT_INVOICE, status: 'paid' });
      const res = await POST(req(), params);
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.code).toBe('paid');
      expect(body.error).toMatch(/amendment/i);
      expect(body.error).toMatch(/job page/i);
      expect(resyncInvoiceToAgreedTotalMock).not.toHaveBeenCalled();
    });

    it('checked BEFORE the no-quote check (a paid invoice with no linked quote still gets the paid refusal)', async () => {
      getInvoiceMock.mockResolvedValue({ ...DEFAULT_INVOICE, status: 'paid', quote_id: null });
      const res = await POST(req(), params);
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('paid');
    });
  });

  // ─── FIX 3 (staff MED 2): no-op honesty ──────────────────────────────────────

  describe('FIX 3 — changed:false when nothing would change', () => {
    it('returns changed:false and skips the write when computeInvoiceResyncTotals already matches the invoice', async () => {
      // These figures are exactly what computeInvoiceResyncTotals produces for
      // RESULT (total 2500), newTotal 2500, deposit 1000, tax_overridden false —
      // see the beforeEach default quote fixture. Hand-derived, not copied from
      // the route: subtotal/discount/tax default to 0 (RESULT carries no
      // breakdown fields), total = newTotal, deposit_applied = depositPaid,
      // balance = total - deposit_applied, credit_note = 0.
      getInvoiceMock.mockResolvedValue({
        ...DEFAULT_INVOICE,
        subtotal: 0,
        discount: 0,
        tax: 0,
        total: 2500,
        deposit_applied: 1000,
        balance: 1500,
        credit_note: 0,
      });
      const res = await POST(req(), params);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, changed: false });
      expect(resyncInvoiceToAgreedTotalMock).not.toHaveBeenCalled();
    });

    it('still calls resyncInvoiceToAgreedTotal when even one field differs (balance off by a cent)', async () => {
      getInvoiceMock.mockResolvedValue({
        ...DEFAULT_INVOICE,
        subtotal: 0,
        discount: 0,
        tax: 0,
        total: 2500,
        deposit_applied: 1000,
        balance: 1500.01,
        credit_note: 0,
      });
      const res = await POST(req(), params);
      expect(res.status).toBe(200);
      expect(resyncInvoiceToAgreedTotalMock).toHaveBeenCalled();
    });
  });

  // ─── FIX 1 (admin lens HIGH part a): durable audit trail ─────────────────────

  describe('FIX 1 — audit trail on a successful resync', () => {
    it('appends a markerOverrides entry with action/by/invoiceId/fromTotal/toTotal in the SAME shape as the real CAS write', async () => {
      const fake = makeFakeQuotes({
        result: RESULT,
        approval_snapshot: { customerSelection: { currentTotalUsd: 2500 } },
        deposit_amount_usd: 1000,
      });
      sbRef.current = fake.client;
      const res = await POST(req(), params);
      expect(res.status).toBe(200);
      expect((await res.json()).audited).toBe(true);
      expect(fake.updates).toHaveLength(1);
      const written = fake.updates[0].approval_snapshot as Record<string, unknown>;
      const overrides = written.markerOverrides as Array<Record<string, unknown>>;
      expect(overrides).toHaveLength(1);
      expect(overrides[0]).toEqual({
        action: 'resync',
        by: 'jason@yulelovelights.com',
        at: expect.any(String),
        invoiceId: INVOICE_ID,
        fromTotal: 2000,
        toTotal: 2500,
      });
    });

    it('uses a FRESH re-read as the CAS base — a marker resyncInvoiceToAgreedTotal cleared in its own success path stays cleared, proving the pre-resync read was not reused', async () => {
      const fake = makeFakeQuotes({
        result: RESULT,
        approval_snapshot: {
          customerSelection: { currentTotalUsd: 2500 },
          invoiceResyncFailed: { invoiceId: INVOICE_ID, attemptedTotal: 2400, at: '2026-08-01T00:00:00Z' },
        },
        deposit_amount_usd: 1000,
      });
      sbRef.current = fake.client;
      // resyncInvoiceToAgreedTotal is mocked, so it never touches the fake DB
      // itself — model its real success-path side effect (clearInvoiceStaleMarkers)
      // out of band, exactly as the real function would before this route's
      // post-resync re-read runs.
      resyncInvoiceToAgreedTotalMock.mockImplementation(async () => {
        fake.state.snapshot = { customerSelection: { currentTotalUsd: 2500 } };
        return { invoicedBalance: 1500, invoicedTotal: 2500, previousInvoicedTotal: 2000, resynced: true };
      });
      const res = await POST(req(), params);
      expect(res.status).toBe(200);
      expect((await res.json()).audited).toBe(true);
      const written = fake.updates[0].approval_snapshot as Record<string, unknown>;
      // The clear survived the audit write — if this route had used the STALE
      // pre-resync read as its CAS base instead, this write would either lose
      // its CAS (the marker moved) or (worse, if written blind) resurrect the
      // marker resyncInvoiceToAgreedTotal had just cleared.
      expect(written.invoiceResyncFailed).toBeUndefined();
      expect((written.markerOverrides as unknown[])).toHaveLength(1);
    });

    it('reports ok:true, audited:false — never undoes the resync or 500s — when the audit CAS write persistently loses its race', async () => {
      const fake = makeFakeQuotes(
        { result: RESULT, approval_snapshot: { customerSelection: { currentTotalUsd: 2500 } }, deposit_amount_usd: 1000 },
        { updateAlwaysConflicts: true },
      );
      sbRef.current = fake.client;
      const res = await POST(req(), params);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.audited).toBe(false);
      expect(body.invoicedTotal).toBe(2500);
      expect(fake.updates).toHaveLength(0);
      expect(console.error).not.toHaveBeenCalled(); // a lost race is a console.warn inside appendQuoteAuditEntry, not an error
    });

    it('reports ok:true, audited:false, and logs an error when the audit CAS write itself errors', async () => {
      const fake = makeFakeQuotes(
        { result: RESULT, approval_snapshot: { customerSelection: { currentTotalUsd: 2500 } }, deposit_amount_usd: 1000 },
        { updateErrors: true },
      );
      sbRef.current = fake.client;
      const res = await POST(req(), params);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.audited).toBe(false);
      expect(console.error).toHaveBeenCalled();
    });

    it('reports ok:true, audited:false and never attempts the write when the post-resync fresh re-read fails', async () => {
      const fake = makeFakeQuotes(
        { result: RESULT, approval_snapshot: { customerSelection: { currentTotalUsd: 2500 } }, deposit_amount_usd: 1000 },
        { failReadOnCall: 2 }, // 1st read = the route's initial quote read (must succeed); 2nd = the post-resync fresh read
      );
      sbRef.current = fake.client;
      const res = await POST(req(), params);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.audited).toBe(false);
      expect(body.invoicedTotal).toBe(2500); // the money write is NOT undone by the audit failure
      expect(fake.updates).toHaveLength(0);
      expect(getOperatorMock).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
    });
  });
});
