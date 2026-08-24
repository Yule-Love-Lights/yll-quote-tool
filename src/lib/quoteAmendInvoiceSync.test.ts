// Direct unit tests for resyncInvoiceToAgreedTotal (src/lib/quoteAmendInvoiceSync.ts).
//
// This shared module is called by BOTH /amend and /amend-decline, but until
// now had zero tests of its own — each route's test file mocks it out
// entirely (verifying only that it's CALLED with the right args), so the
// module's own logic (status reconciliation via canTransition,
// computeInvoiceTotals, paid_at maintenance, the Valor txn rotation) had
// never actually run under test.
//
// LOW finding (fix round 3): "amend-decline can reopen an already-PAID
// invoice (declining a DECREASE) — the module's own comment acknowledges
// it; no test exercises it." This file adds that missing coverage by
// driving the REAL resyncInvoiceToAgreedTotal — the exact function and call
// shape amend-decline/route.ts uses (jobId/invoice/result/depositPaid/
// newTotal/logPrefix/retiredReason: 'amend-decline-reopen') — against a
// PAID invoice with a lower newTotal (what a decline of a DECREASE resolves
// to: resolveAgreedTotal skips the declined entry and reverts to the prior,
// HIGHER agreed total). getInvoiceByJob/appendRetiredTxn (both imported
// from @/lib/invoices) are mocked, matching the existing route-level test
// convention in amend-decline/route.test.ts; computeInvoiceTotals and
// canTransition run for real — the money math and the status-transition
// legality are exactly what this test verifies.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InvoiceRow, InvoicePricingInput } from '@/lib/invoices';

const { sbRef, getInvoiceByJobMock, appendRetiredTxnMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  getInvoiceByJobMock: vi.fn(async (): Promise<unknown> => null),
  appendRetiredTxnMock: vi.fn(async (): Promise<boolean> => true),
}));

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/invoices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/invoices')>();
  return { ...actual, getInvoiceByJob: getInvoiceByJobMock, appendRetiredTxn: appendRetiredTxnMock };
});

import { resyncInvoiceToAgreedTotal, computeInvoiceResyncTotals } from './quoteAmendInvoiceSync';

// Minimal fake matching the direct call this module makes itself:
// sb.from('invoices').update({...}).eq('id', ...).eq('updated_at', ...).select('id')
// — row 339's CAS. `opts.staleUpdatedAt: true` simulates a lost race: some
// other write already changed the invoice's updated_at between the B10
// re-read and this write, so the `.eq('updated_at', ...)` filter matches
// zero rows (the real Postgres behavior an optimistic-lock filter produces).
function makeSb(opts: { staleUpdatedAt?: boolean } = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const eqArgs: Array<[string, unknown]> = [];
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: () => b,
    update: (payload: Record<string, unknown>) => {
      updates.push(payload);
      return b;
    },
    eq: (column: string, value: unknown) => {
      eqArgs.push([column, value]);
      return b;
    },
    select: () => b,
    then: (resolve: (v: unknown) => void) =>
      resolve({ data: opts.staleUpdatedAt ? [] : [{ id: 'inv-1' }], error: null }),
  });
  return { client: b, updates, eqArgs };
}

beforeEach(() => {
  vi.clearAllMocks();
  sbRef.current = null;
});

describe('resyncInvoiceToAgreedTotal — declining a DECREASE reopens an already-PAID invoice', () => {
  it('reopens status to awaiting_payment, clears paid_at, rotates the settled Valor txn, and reports the pre/post totals', async () => {
    const sb = makeSb();
    sbRef.current = sb.client;

    // The invoice was already settled at the (lower) decreased total; the
    // customer then DECLINED that decrease, so resolveAgreedTotal reverts to
    // the prior, HIGHER agreed total (2400) — more is now owed than the
    // invoice, paid at 2000, currently reflects.
    const paidInvoice: InvoiceRow = {
      id: 'inv-1',
      invoice_number: 1,
      job_id: 'job-1',
      quote_id: 'quote-1',
      customer_id: null,
      subtotal: 2000,
      discount: 0,
      tax: 0,
      total: 2000, // the invoice's total BEFORE this decline's resync
      deposit_applied: 1000,
      balance: 0,
      credit_note: 0,
      tax_overridden: false,
      status: 'paid',
      valor_balance_txn_id: 'txn-123',
      valor_receipt_url: 'https://valor.example/r/txn-123',
      valor_txn_log: null,
      payment_preference: null,
      created_at: '2026-07-01T00:00:00.000Z',
      paid_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    };
    // The B10 re-read (resyncInvoiceToAgreedTotal's own freshness check)
    // sees the same settled invoice — no concurrent change.
    getInvoiceByJobMock.mockResolvedValueOnce(paidInvoice);

    const result: InvoicePricingInput & { total: number } = { total: 2400 };
    const outcome = await resyncInvoiceToAgreedTotal({
      jobId: 'job-1',
      invoice: paidInvoice,
      result,
      depositPaid: 1000,
      newTotal: 2400, // the reverted (higher) agreed total after the decline
      logPrefix: '[test]',
      retiredReason: 'amend-decline-reopen',
    });

    // The invoice write reopens it: more is owed (2400 − 1000 = 1400 > 0),
    // so status leaves 'paid' for 'awaiting_payment' and paid_at clears.
    expect(sb.updates[0]).toMatchObject({
      status: 'awaiting_payment',
      total: 2400,
      balance: 1400,
      paid_at: null,
    });

    expect(outcome).toEqual({
      invoicedBalance: 1400,
      invoicedTotal: 2400,
      previousInvoicedTotal: 2000, // the REAL pre-resync invoice total — never reconstructed
    });

    // #170(b): reopening a PAID invoice starts a new charge cycle — the
    // settled Valor txn is retired (not silently overwritten) so a future
    // charge-balance attempt can't collide with last cycle's txn id.
    expect(appendRetiredTxnMock).toHaveBeenCalledTimes(1);
    expect(appendRetiredTxnMock).toHaveBeenCalledWith(
      'inv-1',
      expect.objectContaining({
        txnId: 'txn-123',
        receiptUrl: 'https://valor.example/r/txn-123',
        settledAt: '2026-08-01T00:00:00.000Z',
        reason: 'amend-decline-reopen',
      }),
      { clearLive: { expectTxnId: 'txn-123' } },
    );
  });

  it('does NOT rotate a txn when the reopened invoice never had a real Valor charge (cash-settled)', async () => {
    const sb = makeSb();
    sbRef.current = sb.client;
    const cashPaidInvoice: InvoiceRow = {
      id: 'inv-1',
      invoice_number: 1,
      job_id: 'job-1',
      quote_id: 'quote-1',
      customer_id: null,
      subtotal: 2000,
      discount: 0,
      tax: 0,
      total: 2000,
      deposit_applied: 1000,
      balance: 0,
      credit_note: 0,
      tax_overridden: false,
      status: 'paid',
      valor_balance_txn_id: null,
      valor_receipt_url: null,
      valor_txn_log: null,
      payment_preference: null,
      created_at: '2026-07-01T00:00:00.000Z',
      paid_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    };
    getInvoiceByJobMock.mockResolvedValueOnce(cashPaidInvoice);

    await resyncInvoiceToAgreedTotal({
      jobId: 'job-1',
      invoice: cashPaidInvoice,
      result: { total: 2400 },
      depositPaid: 1000,
      newTotal: 2400,
      logPrefix: '[test]',
      retiredReason: 'amend-decline-reopen',
    });

    expect(sb.updates[0]).toMatchObject({ status: 'awaiting_payment' });
    expect(appendRetiredTxnMock).not.toHaveBeenCalled();
  });
});

// Row 339 (LOW, #830/#862 shape): resyncInvoiceToAgreedTotal's own B10
// re-read narrows the window between reading the invoice and writing it, but
// (per that comment) does not eliminate it — a second write could still land
// in the gap between the re-read and this write. The CAS below closes that
// gap: the write also filters on the invoice's `updated_at` from the SAME
// re-read, so a write that lands after a concurrent change matches zero rows
// instead of silently overwriting it with now-stale totals.
describe('resyncInvoiceToAgreedTotal — CAS on the invoices write (row 339)', () => {
  it('sends the updated_at filter alongside the id filter, from the freshly re-read invoice', async () => {
    const sb = makeSb();
    sbRef.current = sb.client;
    const invoice: InvoiceRow = {
      id: 'inv-1',
      invoice_number: 1,
      job_id: 'job-1',
      quote_id: 'quote-1',
      customer_id: null,
      subtotal: 1000,
      discount: 0,
      tax: 0,
      total: 1000,
      deposit_applied: 500,
      balance: 500,
      credit_note: 0,
      tax_overridden: false,
      status: 'draft',
      valor_balance_txn_id: null,
      valor_receipt_url: null,
      valor_txn_log: null,
      payment_preference: null,
      created_at: '2026-07-01T00:00:00.000Z',
      paid_at: null,
      updated_at: '2026-08-20T10:00:00.000Z',
    };
    // The B10 re-read returns the SAME row (freshly re-fetched) — its
    // updated_at is what the CAS filter must key on.
    getInvoiceByJobMock.mockResolvedValueOnce(invoice);

    const outcome = await resyncInvoiceToAgreedTotal({
      jobId: 'job-1',
      invoice,
      result: { total: 1200 },
      depositPaid: 500,
      newTotal: 1200,
      logPrefix: '[test]',
      retiredReason: 'amend-reopen',
    });

    expect(sb.eqArgs).toContainEqual(['id', 'inv-1']);
    expect(sb.eqArgs).toContainEqual(['updated_at', '2026-08-20T10:00:00.000Z']);
    expect(outcome).toEqual({
      invoicedBalance: 700,
      invoicedTotal: 1200,
      previousInvoicedTotal: 1000,
    });
  });

  it('returns a null outcome and skips the Valor rotation when a concurrent write already changed the invoice (CAS lost)', async () => {
    const sb = makeSb({ staleUpdatedAt: true });
    sbRef.current = sb.client;
    // A PAID invoice whose reopen would normally retire a live Valor txn —
    // proving the CAS loss short-circuits BEFORE that side effect, not just
    // before the returned totals.
    const invoice: InvoiceRow = {
      id: 'inv-1',
      invoice_number: 1,
      job_id: 'job-1',
      quote_id: 'quote-1',
      customer_id: null,
      subtotal: 2000,
      discount: 0,
      tax: 0,
      total: 2000,
      deposit_applied: 1000,
      balance: 0,
      credit_note: 0,
      tax_overridden: false,
      status: 'paid',
      valor_balance_txn_id: 'txn-123',
      valor_receipt_url: 'https://valor.example/r/txn-123',
      valor_txn_log: null,
      payment_preference: null,
      created_at: '2026-07-01T00:00:00.000Z',
      paid_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    };
    getInvoiceByJobMock.mockResolvedValueOnce(invoice);

    const outcome = await resyncInvoiceToAgreedTotal({
      jobId: 'job-1',
      invoice,
      result: { total: 2400 },
      depositPaid: 1000,
      newTotal: 2400,
      logPrefix: '[test]',
      retiredReason: 'amend-decline-reopen',
    });

    expect(outcome).toEqual({
      invoicedBalance: null,
      invoicedTotal: null,
      previousInvoicedTotal: null,
    });
    expect(appendRetiredTxnMock).not.toHaveBeenCalled();
  });
});

// FIX A (fix round 4): computeInvoiceResyncTotals is the money formula PULLED
// OUT of resyncInvoiceToAgreedTotal so the amend route can compute the SAME
// invoice-basis figures BEFORE it persists the amendment trail entry (see
// that route's pre-write invoice_basis stamp) — no IO, no mocks needed. These
// tests pin the formula directly. One test below shares its exact fixture
// numbers with the "declining a DECREASE" test in the describe block above
// (task (b) rename, fix round 5: that test's name used to claim this proves
// the two call sites "agree byte-for-byte" — it doesn't call
// resyncInvoiceToAgreedTotal, so the fixtures matching is a manual tripwire,
// not a programmatic cross-check; see that test's own comment).
describe('computeInvoiceResyncTotals — the shared money formula (no IO)', () => {
  it('scales the removable tax to the new agreed total on a tax-overridden invoice (#125-1)', () => {
    // Full quote 5600 (450 tax on a 5150 subtotal); re-syncing to the full
    // agreed total (5600) removes the FULL 450 (no partial scaling needed).
    const result: InvoicePricingInput & { total: number } = {
      subtotalBeforeDiscount: 5150,
      discountAmount: 0,
      taxAmount: 450,
      total: 5600,
    };
    const totals = computeInvoiceResyncTotals(result, 2500, 5600, true);
    expect(totals.total).toBe(5150);
    expect(totals.balance).toBe(2650);
  });

  // Task (b) rename (fix round 5): this test previously claimed to prove
  // computeInvoiceResyncTotals and resyncInvoiceToAgreedTotal "agree
  // byte-for-byte" — but it never calls resyncInvoiceToAgreedTotal, only
  // this pure function, with a fixture hand-copied from the "declining a
  // DECREASE" test above (whose sb.updates[0]/outcome assertions were typed
  // in independently). Genuinely calling both here would be a comparison
  // that trivially agrees by construction — resyncInvoiceToAgreedTotal's
  // `totals` variable literally IS this function's return value (see
  // quoteAmendInvoiceSync.ts), so cross-calling would test the plumbing, not
  // catch a real divergence. What actually guards against drift: both
  // fixtures are the SAME literal numbers, so an edit to either formula that
  // changes the result breaks whichever of the two tests nobody remembered
  // to update — a manual tripwire, not a programmatic one.
  it('pins the same total/balance the "declining a DECREASE" resync test hand-verifies on its real write, for the identical fixture (result.total=2400, depositPaid=1000, newTotal=2400) — not verified here by calling resyncInvoiceToAgreedTotal', () => {
    const result: InvoicePricingInput & { total: number } = { total: 2400 };
    const totals = computeInvoiceResyncTotals(result, 1000, 2400, false);
    expect(totals.total).toBe(2400);
    expect(totals.balance).toBe(1400);
  });

  it('leaves the total untouched when tax is not overridden', () => {
    const result: InvoicePricingInput & { total: number } = {
      subtotalBeforeDiscount: 5150,
      discountAmount: 0,
      taxAmount: 450,
      total: 5600,
    };
    const totals = computeInvoiceResyncTotals(result, 2500, 5600, false);
    expect(totals.total).toBe(5600); // no tax removed
    expect(totals.balance).toBe(3100);
  });
});
