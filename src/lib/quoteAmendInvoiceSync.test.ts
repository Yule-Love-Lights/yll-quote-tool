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

import {
  resyncInvoiceToAgreedTotal,
  computeInvoiceResyncTotals,
  isStaleInvoiceSnapshot,
  priorCollectedWarning,
} from './quoteAmendInvoiceSync';

// Table-aware fake matching the two calls this module (+ its row-341 marker
// helper) make against Supabase:
//   sb.from('invoices').update({...}).eq('id',...).eq('updated_at',...).select('id')
//     — row 339's CAS write. `invoiceUpdateResults` is a queue, one entry
//     consumed per CALL (so a retry's second attempt can behave differently
//     from the first) — 'raced' simulates a lost race (the real Postgres
//     behavior an optimistic-lock filter produces: 0 rows, no error); the
//     queue's LAST entry repeats once exhausted. Defaults to always-'ok'.
//   sb.from('quotes').select('approval_snapshot').eq('id',...).maybeSingle()
//     then sb.from('quotes').update({approval_snapshot:...}).eq('id',...)
//     — row 341's flagInvoiceResyncFailed, only reached when the resync
//     ultimately fails. `quoteApprovalSnapshot` seeds the select's result.
function makeSb(
  opts: {
    invoiceUpdateResults?: Array<'ok' | 'raced'>;
    quoteApprovalSnapshot?: Record<string, unknown> | null;
    // Row 341 fix round 3 (negative control for the flagInvoiceResyncFailed
    // CAS): 'raced' simulates the same 0-rows-no-error shape the invoices
    // CAS uses when a concurrent write already changed approval_snapshot.
    quoteUpdateResult?: 'ok' | 'raced';
    // Row 411 fix round (delta-verify MED): simulate the quotes-select READ
    // itself failing — { data: null, error } — so the skip-on-unconfirmed
    // guard in flagInvoiceResyncFailed is actually reachable. Without this the
    // fake structurally could not exercise that branch, and a probe reverted
    // the guard with every test green.
    quoteReadFails?: boolean;
  } = {},
) {
  const invoiceUpdates: Array<Record<string, unknown>> = [];
  const quoteUpdates: Array<Record<string, unknown>> = [];
  const eqArgs: Array<[string, unknown]> = [];
  const quoteEqArgs: Array<[string, unknown]> = [];
  const results = opts.invoiceUpdateResults ?? ['ok'];
  let invoiceCallIndex = 0;
  let table = '';
  let mode: 'select' | 'update' = 'select';
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: (t: string) => {
      table = t;
      mode = 'select';
      return b;
    },
    update: (payload: Record<string, unknown>) => {
      mode = 'update';
      if (table === 'invoices') invoiceUpdates.push(payload);
      else if (table === 'quotes') quoteUpdates.push(payload);
      return b;
    },
    eq: (column: string, value: unknown) => {
      if (table === 'invoices') eqArgs.push([column, value]);
      else if (table === 'quotes') quoteEqArgs.push([column, value]);
      return b;
    },
    select: () => b,
    maybeSingle: async () =>
      table === 'quotes' && opts.quoteReadFails
        ? { data: null, error: { message: 'connection reset' } }
        : {
            data: table === 'quotes' ? { approval_snapshot: opts.quoteApprovalSnapshot ?? null } : null,
            error: null,
          },
    then: (resolve: (v: unknown) => void) => {
      if (table === 'invoices' && mode === 'update') {
        const outcome = results[Math.min(invoiceCallIndex, results.length - 1)];
        invoiceCallIndex++;
        resolve({ data: outcome === 'ok' ? [{ id: 'inv-1' }] : [], error: null });
        return;
      }
      if (table === 'quotes' && mode === 'update') {
        const raced = opts.quoteUpdateResult === 'raced';
        resolve({ data: raced ? [] : [{ id: 'quote-1' }], error: null });
        return;
      }
      resolve({ data: null, error: null });
    },
  });
  return { client: b, invoiceUpdates, quoteUpdates, eqArgs, quoteEqArgs };
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

    // The invoice write reopens it — but paidInvoice was already SETTLED at
    // 2000 (deposit 1000 + a real balance payment of 1000, balance: 0 below),
    // so that extra 1000 is money already in hand, not owed again: real
    // balance owed = 2400 (new total) − 2000 (already collected) = 400. Row
    // 341 fix round 3 (priorBalanceCollectedUsd): before this fix the code
    // computed 2400 − 1000 (deposit only) = 1400, a ~1000 double-charge on a
    // customer who had already paid in full for the prior total.
    expect(sb.invoiceUpdates[0]).toMatchObject({
      status: 'awaiting_payment',
      total: 2400,
      balance: 400,
      paid_at: null,
    });

    expect(outcome).toEqual({
      invoicedBalance: 400,
      invoicedTotal: 2400,
      previousInvoicedTotal: 2000, // the REAL pre-resync invoice total — never reconstructed
      resynced: true,
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

    expect(sb.invoiceUpdates[0]).toMatchObject({ status: 'awaiting_payment' });
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
      resynced: true,
    });
  });

  it('retries ONCE against a fresh read after a lost race, and succeeds when the second attempt lands — reopening an invoice the Valor balance webhook just settled at the STALE (pre-amendment) balance (row 341)', async () => {
    // First invoices-table update call loses the CAS (0 rows); the retry's
    // second call lands.
    const sb = makeSb({ invoiceUpdateResults: ['raced', 'ok'] });
    sbRef.current = sb.client;

    const invoiceAtAmendTime: InvoiceRow = {
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
    // Between the first (lost) write attempt and the retry's re-read, the
    // Valor balance webhook (handleBalancePayment) settles the invoice at the
    // STALE balance it saw — status/balance/paid_at/txn fields move, total/
    // tax/subtotal do NOT (the webhook never writes them; matches its real
    // write shape in src/app/api/integrations/valor/webhook/route.ts).
    const webhookSettledInvoice: InvoiceRow = {
      ...invoiceAtAmendTime,
      status: 'paid',
      balance: 0,
      paid_at: '2026-08-20T10:00:05.000Z',
      valor_balance_txn_id: 'txn-webhook',
      valor_receipt_url: 'https://valor.example/r/txn-webhook',
      updated_at: '2026-08-20T10:00:05.000Z',
    };
    getInvoiceByJobMock
      .mockResolvedValueOnce(invoiceAtAmendTime) // the initial B10 re-read
      .mockResolvedValueOnce(webhookSettledInvoice); // the retry's re-read

    const outcome = await resyncInvoiceToAgreedTotal({
      jobId: 'job-1',
      invoice: invoiceAtAmendTime,
      result: { total: 1400 },
      depositPaid: 500,
      newTotal: 1400, // the amended, HIGHER agreed total — more is now owed
      logPrefix: '[test]',
      retiredReason: 'amend-reopen',
    });

    expect(getInvoiceByJobMock).toHaveBeenCalledTimes(2);
    expect(sb.invoiceUpdates).toHaveLength(2);
    // The retry recomputed against the webhook-settled row: the webhook
    // itself already collected 500 beyond the deposit (deposit 500 + the
    // webhook's own settled balance 500 = 1000 already in hand), so the real
    // amount still owed on the amended 1400 total is 1400 − 1000 = 400, not
    // 1400 − 500 (deposit only) = 900. Row 341 fix round 3
    // (priorBalanceCollectedUsd): before this fix the code ignored the
    // webhook's own payment and would have re-billed the customer for money
    // already collected in the SAME retry that exists specifically to react
    // to that webhook settlement. The row now reads 'paid' pre-resync, so
    // reconciledStatus still reopens it to 'awaiting_payment' (something —
    // 400 — remains owed on the new total).
    expect(sb.invoiceUpdates[1]).toMatchObject({ status: 'awaiting_payment', total: 1400, balance: 400 });
    expect(outcome).toEqual({
      invoicedBalance: 400,
      invoicedTotal: 1400,
      previousInvoicedTotal: 1000, // webhookSettledInvoice.total — the webhook never touched it
      resynced: true,
    });
    // The reopen also retires the webhook's OWN settled txn (#170(b)) — proof
    // the retry recomputed off the webhook-settled row's real fields, not the
    // stale first read.
    expect(appendRetiredTxnMock).toHaveBeenCalledTimes(1);
    expect(appendRetiredTxnMock).toHaveBeenCalledWith(
      'inv-1',
      expect.objectContaining({ txnId: 'txn-webhook', reason: 'amend-reopen' }),
      { clearLive: { expectTxnId: 'txn-webhook' } },
    );
  });

  it('gives up after the retry ALSO loses the race — resynced:false, no Valor rotation, and a durable invoiceResyncFailed marker on the quote (row 341, CAS lost twice)', async () => {
    const sb = makeSb({
      invoiceUpdateResults: ['raced', 'raced'],
      quoteApprovalSnapshot: { amendments: [{ amended_at: 'x' }] },
    });
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
    getInvoiceByJobMock.mockResolvedValue(invoice); // both the B10 read and the one retry see it unchanged

    const outcome = await resyncInvoiceToAgreedTotal({
      jobId: 'job-1',
      invoice,
      result: { total: 2400 },
      depositPaid: 1000,
      newTotal: 2400,
      logPrefix: '[test]',
      retiredReason: 'amend-decline-reopen',
    });

    expect(getInvoiceByJobMock).toHaveBeenCalledTimes(2); // the B10 read + the one retry
    expect(sb.invoiceUpdates).toHaveLength(2); // both attempts genuinely tried the write
    expect(outcome).toEqual({
      invoicedBalance: null,
      invoicedTotal: null,
      previousInvoicedTotal: null,
      resynced: false,
    });
    expect(appendRetiredTxnMock).not.toHaveBeenCalled();
    // Row 341: a durable, best-effort marker lands on the quote (mirrors the
    // Valor webhook's own flagBalanceUnderpayment/duplicatePayment shape) so
    // the failure is discoverable even though nothing in THIS response saw
    // it directly.
    expect(sb.quoteUpdates).toHaveLength(1);
    expect(sb.quoteUpdates[0]).toMatchObject({
      approval_snapshot: {
        amendments: [{ amended_at: 'x' }], // the existing snapshot content is preserved, not clobbered
        invoiceResyncFailed: expect.objectContaining({
          invoiceId: 'inv-1',
          attemptedTotal: 2400,
          // Same already-settled invoice as the "declining a DECREASE"
          // test above (total 2000, deposit_applied 1000, balance 0 — 1000
          // already collected beyond the deposit): the attempted balance is
          // 2400 − 2000 = 400, not the deposit-only 2400 − 1000 = 1400.
          attemptedBalance: 400,
        }),
      },
    });
  });
});

// Row 341 fix round 3 (technical-lens HIGH): flagInvoiceResyncFailed used to
// be a blind read-modify-write of quotes.approval_snapshot; it now CASes on
// the exact snapshot it read, matching every other writer of that column.
// These tests exercise the CAS itself, which the "gives up" test above never
// did — that test only ever hit the always-succeeds branch of the mock.
describe('flagInvoiceResyncFailed — CAS on approval_snapshot (row 341 fix round 3)', () => {
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

  it('CASes the marker write on the exact prior snapshot it read', async () => {
    const sb = makeSb({
      invoiceUpdateResults: ['raced', 'raced'],
      quoteApprovalSnapshot: { amendments: [{ amended_at: 'x' }] },
    });
    sbRef.current = sb.client;
    getInvoiceByJobMock.mockResolvedValue(invoice);

    await resyncInvoiceToAgreedTotal({
      jobId: 'job-1',
      invoice,
      result: { total: 2400 },
      depositPaid: 1000,
      newTotal: 2400,
      logPrefix: '[test]',
      retiredReason: 'amend-decline-reopen',
    });

    expect(sb.quoteEqArgs).toContainEqual(['id', 'quote-1']);
    expect(sb.quoteEqArgs).toContainEqual([
      'approval_snapshot',
      JSON.stringify({ amendments: [{ amended_at: 'x' }] }),
    ]);
  });

  it('drops the marker (does not throw, does not retry) when the CAS loses a concurrent write to approval_snapshot', async () => {
    const sb = makeSb({
      invoiceUpdateResults: ['raced', 'raced'],
      quoteApprovalSnapshot: { amendments: [{ amended_at: 'x' }] },
      quoteUpdateResult: 'raced',
    });
    sbRef.current = sb.client;
    getInvoiceByJobMock.mockResolvedValue(invoice);

    // Must not throw — a lost marker is best-effort, never a request failure.
    const outcome = await resyncInvoiceToAgreedTotal({
      jobId: 'job-1',
      invoice,
      result: { total: 2400 },
      depositPaid: 1000,
      newTotal: 2400,
      logPrefix: '[test]',
      retiredReason: 'amend-decline-reopen',
    });

    expect(outcome.resynced).toBe(false);
    // Exactly ONE attempt at the marker write — a lost CAS race is dropped,
    // never retried and never blind-overwritten (unlike the invoices CAS,
    // which retries once against a fresh read).
    expect(sb.quoteUpdates).toHaveLength(1);
  });

  it('SKIPS the marker write entirely when the snapshot read fails — never degrades to {} (row 411)', async () => {
    // The reviewed data-loss pattern: a failed read coerced to {} and CAS'd
    // against '{}'. The CAS bounded the damage to a dropped marker with a
    // misleading lost-the-race log, but the guard must SKIP — no quotes-table
    // write at all. Mutation-proof: reverting the guard to the old ?? {}
    // coercion makes this fail (a quotes update is attempted).
    const sb = makeSb({
      invoiceUpdateResults: ['raced', 'raced'],
      quoteReadFails: true,
    });
    sbRef.current = sb.client;
    getInvoiceByJobMock.mockResolvedValue(invoice);

    const outcome = await resyncInvoiceToAgreedTotal({
      jobId: 'job-1',
      invoice,
      result: { total: 2400 },
      depositPaid: 1000,
      newTotal: 2400,
      logPrefix: '[test]',
      retiredReason: 'amend-decline-reopen',
    });

    expect(outcome.resynced).toBe(false); // the resync failure is still reported
    expect(sb.quoteUpdates).toHaveLength(0); // but NO snapshot write was attempted
  });
});

// Row 394 fix round 2 (delta-verify LOW — a test-name-claims-more-than-it-
// proves finding, this repo's own named pitfall): the ORIGINAL "drops the
// clear... when the CAS loses a concurrent write" test below simulated the
// lost race with a canned `quoteUpdateResult: 'raced'` flag on the shared
// makeSb() fake — a flag whose truthiness is INDEPENDENT of what the code
// actually sends in `.eq('approval_snapshot', ...)`. A mutation probe
// (deleting that real `.eq()` call from clearInvoiceStaleMarkers) proved it:
// the test still PASSED, because a DIFFERENT assertion in a DIFFERENT test
// happened to catch the removal instead. This fake replaces the canned flag
// with real optimistic-lock semantics — it holds actual server-side state
// and only accepts a `quotes` update when every filter the caller ACTUALLY
// sent still matches that state (exactly what Postgres does), so removing
// the `.eq('approval_snapshot', ...)` call changes the fake's behavior, not
// just a boolean the test author chose.
function makeCasAwareQuoteSb(opts: {
  initialQuoteSnapshot: Record<string, unknown>;
  invoiceUpdateResults?: Array<'ok' | 'raced'>;
}) {
  let quoteSnapshot: Record<string, unknown> = opts.initialQuoteSnapshot;
  const quoteUpdates: Array<Record<string, unknown>> = [];
  const results = opts.invoiceUpdateResults ?? ['ok'];
  let invoiceCallIndex = 0;
  let table = '';
  let mode: 'select' | 'update' = 'select';
  let eqFilters: Array<[string, unknown]> = [];
  let pendingQuoteUpdate: Record<string, unknown> | null = null;
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: (t: string) => {
      table = t;
      mode = 'select';
      eqFilters = [];
      return b;
    },
    update: (payload: Record<string, unknown>) => {
      mode = 'update';
      if (table === 'quotes') {
        quoteUpdates.push(payload);
        pendingQuoteUpdate = payload;
      }
      return b;
    },
    eq: (column: string, value: unknown) => {
      eqFilters.push([column, value]);
      return b;
    },
    select: () => b,
    maybeSingle: async () => {
      if (table === 'quotes') {
        const readValue = quoteSnapshot;
        // Simulate a concurrent write landing in the EXACT gap between this
        // read and the CAS write below — deterministic single-threaded
        // stand-in for "something else committed first," the precise race
        // clearInvoiceStaleMarkers's CAS exists to detect.
        quoteSnapshot = {
          ...quoteSnapshot,
          amendments: [
            ...(((quoteSnapshot as { amendments?: unknown[] }).amendments) ?? []),
            { concurrent: true },
          ],
        };
        return { data: { approval_snapshot: readValue }, error: null };
      }
      return { data: null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      if (table === 'invoices' && mode === 'update') {
        const outcome = results[Math.min(invoiceCallIndex, results.length - 1)];
        invoiceCallIndex++;
        resolve({ data: outcome === 'ok' ? [{ id: 'inv-1' }] : [], error: null });
        return;
      }
      if (table === 'quotes' && mode === 'update') {
        // Real CAS semantics: only the filters ACTUALLY sent constrain the
        // match. Remove the approval_snapshot filter and this succeeds
        // regardless of drift, exactly like real Postgres would too.
        const idFilter = eqFilters.find(([c]) => c === 'id');
        const snapshotFilter = eqFilters.find(([c]) => c === 'approval_snapshot');
        const idMatches = !idFilter || idFilter[1] === 'quote-1';
        const snapshotMatches = !snapshotFilter || snapshotFilter[1] === JSON.stringify(quoteSnapshot);
        if (idMatches && snapshotMatches && pendingQuoteUpdate) {
          quoteSnapshot = pendingQuoteUpdate.approval_snapshot as Record<string, unknown>;
          resolve({ data: [{ id: 'quote-1' }], error: null });
        } else {
          resolve({ data: [], error: null });
        }
        return;
      }
      resolve({ data: null, error: null });
    },
  });
  return {
    client: b,
    quoteUpdates,
    get quoteSnapshot() {
      return quoteSnapshot;
    },
  };
}

describe('resyncInvoiceToAgreedTotal — clears the stale-invoice markers on a SUCCESSFUL resync (row 394)', () => {
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
    balance: 1000,
    credit_note: 0,
    tax_overridden: false,
    status: 'awaiting_payment',
    valor_balance_txn_id: null,
    valor_receipt_url: null,
    valor_txn_log: null,
    payment_preference: null,
    created_at: '2026-07-01T00:00:00.000Z',
    paid_at: null,
    updated_at: '2026-08-01T00:00:00.000Z',
  };

  it('clears BOTH paymentBlocked and invoiceResyncFailed, preserving every other snapshot key', async () => {
    const priorSnapshot = {
      amendments: [{ amended_at: 'x' }],
      paymentBlocked: { invoiceId: 'inv-1', storedBalance: 1000, expectedBalance: 1400, at: 'a', lastAlertedAt: 'a' },
      invoiceResyncFailed: { invoiceId: 'inv-1', attemptedTotal: 2400, attemptedBalance: 1400, at: 'b' },
    };
    const sb = makeSb({ quoteApprovalSnapshot: priorSnapshot });
    sbRef.current = sb.client;
    getInvoiceByJobMock.mockResolvedValue(invoice);

    const outcome = await resyncInvoiceToAgreedTotal({
      jobId: 'job-1',
      invoice,
      result: { total: 2400 },
      depositPaid: 1000,
      newTotal: 2400,
      logPrefix: '[test]',
      retiredReason: 'amend-reopen',
    });

    expect(outcome.resynced).toBe(true);
    // Exactly one quotes-table write: the marker clear (flagInvoiceResyncFailed
    // never runs on a success path).
    expect(sb.quoteUpdates).toHaveLength(1);
    expect(sb.quoteUpdates[0]).toEqual({
      approval_snapshot: { amendments: [{ amended_at: 'x' }] },
    });
    // CASed on the EXACT prior snapshot this call read, same idiom as every
    // other approval_snapshot writer in this file.
    expect(sb.quoteEqArgs).toContainEqual(['approval_snapshot', JSON.stringify(priorSnapshot)]);
  });

  it('is a no-op (no quotes-table write) when neither marker is present', async () => {
    const priorSnapshot = { amendments: [{ amended_at: 'x' }] };
    const sb = makeSb({ quoteApprovalSnapshot: priorSnapshot });
    sbRef.current = sb.client;
    getInvoiceByJobMock.mockResolvedValue(invoice);

    const outcome = await resyncInvoiceToAgreedTotal({
      jobId: 'job-1',
      invoice,
      result: { total: 2400 },
      depositPaid: 1000,
      newTotal: 2400,
      logPrefix: '[test]',
      retiredReason: 'amend-reopen',
    });

    expect(outcome.resynced).toBe(true);
    expect(sb.quoteUpdates).toHaveLength(0);
  });

  it('drops the clear (does not throw, does not retry, resync still reports success) when the CAS loses a concurrent write — proven against the fake\'s own server state, not a canned flag', async () => {
    const initialSnapshot = {
      amendments: [{ amended_at: 'x' }],
      paymentBlocked: { invoiceId: 'inv-1', storedBalance: 1000, expectedBalance: 1400, at: 'a', lastAlertedAt: 'a' },
    };
    const sb = makeCasAwareQuoteSb({ initialQuoteSnapshot: initialSnapshot });
    sbRef.current = sb.client;
    getInvoiceByJobMock.mockResolvedValue(invoice);

    const outcome = await resyncInvoiceToAgreedTotal({
      jobId: 'job-1',
      invoice,
      result: { total: 2400 },
      depositPaid: 1000,
      newTotal: 2400,
      logPrefix: '[test]',
      retiredReason: 'amend-reopen',
    });

    // The resync itself still succeeded — a lost marker-clear race is
    // best-effort and must never turn a real success into a failure.
    expect(outcome.resynced).toBe(true);
    expect(sb.quoteUpdates).toHaveLength(1); // one attempt, not retried

    // Real proof the CAS FILTER is what stopped the write, not a canned
    // flag: the fake's own server-side snapshot still carries the
    // concurrent write's amendment (the clear's write never actually
    // applied, so it never clobbered it) AND still carries the marker the
    // clear tried to remove.
    const finalSnapshot = sb.quoteSnapshot as {
      amendments?: Array<{ concurrent?: boolean }>;
      paymentBlocked?: unknown;
    };
    expect(finalSnapshot.amendments?.some((a) => a.concurrent)).toBe(true);
    expect(finalSnapshot.paymentBlocked).toBeDefined();
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

describe('isStaleInvoiceSnapshot — row 389 (no IO)', () => {
  it('is false on a clean snapshot with neither marker', () => {
    expect(isStaleInvoiceSnapshot({})).toBe(false);
  });

  it('is false on null/undefined (a quote with no snapshot yet)', () => {
    expect(isStaleInvoiceSnapshot(null)).toBe(false);
    expect(isStaleInvoiceSnapshot(undefined)).toBe(false);
  });

  it('is true when paymentBlocked is present (pay-balance/route.ts refusal)', () => {
    expect(isStaleInvoiceSnapshot({ paymentBlocked: { at: '2026-08-24T00:00:00Z' } })).toBe(true);
  });

  it('is true when invoiceResyncFailed is present (flagInvoiceResyncFailed)', () => {
    expect(
      isStaleInvoiceSnapshot({ invoiceResyncFailed: { invoiceId: 'inv-1', attemptedTotal: 100 } }),
    ).toBe(true);
  });

  it('is true when BOTH markers are present', () => {
    expect(
      isStaleInvoiceSnapshot({ paymentBlocked: { at: 'x' }, invoiceResyncFailed: { invoiceId: 'y' } }),
    ).toBe(true);
  });
});

// Row 395 fix: moved here from src/app/admin/invoices/[id]/page.test.tsx —
// the function relocated (Jason's ruling) to /admin/jobs/[id]'s "Record
// amendment" panel, where this inference actually drives money; the invoice
// detail page's copy was removed outright (it fired on 100% of settled
// invoices, not a genuine caution). These are the same assertions the
// removed page test carried, unchanged except the import path.
describe('priorCollectedWarning — row 395 (no IO)', () => {
  it('is null when nothing has been collected beyond the deposit', () => {
    expect(priorCollectedWarning({ total: 1000, balance: 600, deposit_applied: 400 })).toBeNull();
  });

  it('is null when the invoice is fully settled by the deposit alone (balance 0, gap 0)', () => {
    expect(priorCollectedWarning({ total: 400, balance: 0, deposit_applied: 400 })).toBeNull();
  });

  it('warns with the exact dollar figure once a balance payment has landed beyond the deposit', () => {
    // total 1000, deposit 400, balance 0 → 600 collected beyond the deposit.
    const note = priorCollectedWarning({ total: 1000, balance: 0, deposit_applied: 400 });
    expect(note).not.toBeNull();
    expect(note).toContain('$600.00');
    expect(note).toMatch(/refund/i);
    expect(note).toMatch(/Valor/);
  });

  it('is null on a partial/legacy row missing a needed field (defensive, matches priorBalanceCollectedUsd)', () => {
    expect(priorCollectedWarning({ total: null, balance: 0, deposit_applied: 400 })).toBeNull();
    expect(priorCollectedWarning({ total: 1000, balance: undefined, deposit_applied: 400 })).toBeNull();
  });
});
