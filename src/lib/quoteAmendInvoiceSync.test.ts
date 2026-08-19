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

// Minimal fake matching the ONE direct call this module makes itself:
// sb.from('invoices').update({...}).eq('id', invoiceForSync.id) — no
// .select(), so `.eq()` must itself be awaitable (a thenable).
function makeSb() {
  const updates: Array<Record<string, unknown>> = [];
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: () => b,
    update: (payload: Record<string, unknown>) => {
      updates.push(payload);
      return b;
    },
    eq: () => b,
    then: (resolve: (v: unknown) => void) => resolve({ data: [{ id: 'inv-1' }], error: null }),
  });
  return { client: b, updates };
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

// FIX A (fix round 4): computeInvoiceResyncTotals is the money formula PULLED
// OUT of resyncInvoiceToAgreedTotal so the amend route can compute the SAME
// invoice-basis figures BEFORE it persists the amendment trail entry (see
// that route's pre-write invoice_basis stamp) — no IO, no mocks needed. These
// tests pin the formula directly, and prove it against the SAME inputs the
// describe block above already drives through the real resyncInvoiceToAgreedTotal,
// confirming the two call sites can't silently diverge into two different
// numbers for what is supposed to be one figure.
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

  it('produces the IDENTICAL total/balance that resyncInvoiceToAgreedTotal actually writes, for the same inputs', () => {
    // The exact fixture from the "declining a DECREASE reopens an
    // already-PAID invoice" test above — proving the pre-write computation
    // (this function) and the real invoice-table write (that test's
    // sb.updates[0] / outcome) agree byte-for-byte on the same inputs, which
    // is the whole safety argument for eliminating the amend route's second
    // write in favor of computing this up front.
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
