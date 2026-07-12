// Tests for POST /api/jobs/[id]/cancel (#83 cancellation). Cancels job + invoice +
// quote; refunds stay manual in Valor. Operator-gated; data layer mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const {
  getJob,
  setJobStatus,
  getInvoiceByJob,
  setInvoiceStatus,
  requireOperatorMock,
  sbRef,
  hl,
  releaseAccrualOnCancelMock,
  getJobWorkOrderMock,
  adjustOnHandAtomicMock,
} = vi.hoisted(() => ({
  getJob: vi.fn(),
  setJobStatus: vi.fn(),
  getInvoiceByJob: vi.fn(),
  setInvoiceStatus: vi.fn(),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  sbRef: { current: null as unknown },
  hl: { sendEmail: vi.fn(async () => ({})), configured: { value: true } },
  releaseAccrualOnCancelMock: vi.fn(async () => ({ released: false })),
  getJobWorkOrderMock: vi.fn(),
  adjustOnHandAtomicMock: vi.fn(async () => {}),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/jobs', () => ({ getJob, setJobStatus }));
vi.mock('@/lib/invoices', () => ({ getInvoiceByJob, setInvoiceStatus }));
vi.mock('@/lib/integrations/highlevel', () => ({
  sendEmail: hl.sendEmail,
  isHighLevelConfigured: () => hl.configured.value,
}));
// Referral program (#41 adversarial-review MED fix): mocked so its OWN DB
// logic (covered in src/lib/referrals.test.ts) doesn't add extra `.update()`
// calls to this file's shared quote-row fake (which the W1-008 tests below
// index into positionally) — this file's job is only the wiring + fail-open.
vi.mock('@/lib/referrals', () => ({ releaseAccrualOnCancel: releaseAccrualOnCancelMock }));
// WT-31: only stub getJobWorkOrder (its own projection/BOM machinery is
// covered elsewhere — jobsPrepare.test.ts et al.); keep the REAL
// computeStockDeductions so the reversal math under test is the genuine
// prepare-path math, not a re-implemented double.
vi.mock('@/lib/inventory/jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/inventory/jobs')>();
  return { ...actual, getJobWorkOrder: getJobWorkOrderMock };
});
vi.mock('@/lib/inventory/onHand', () => ({ adjustOnHandAtomic: adjustOnHandAtomicMock }));

import { POST } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = { nextUrl: { origin: 'https://quote.example.com' } } as unknown as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

function fakeSb(quoteRow: Record<string, unknown> = { deposit_paid_at: null }) {
  const updates: Record<string, unknown>[] = [];
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: () => b,
    select: () => b,
    update: (p: Record<string, unknown>) => {
      updates.push(p);
      return b;
    },
    eq: () => b,
    maybeSingle: async () => ({ data: quoteRow, error: null }),
    then: (resolve: (v: unknown) => void) => resolve({ error: null }),
  });
  return { client: b, updates };
}

let sb: ReturnType<typeof fakeSb>;
beforeEach(() => {
  vi.clearAllMocks();
  hl.configured.value = true;
  process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
  requireOperatorMock.mockResolvedValue(null);
  getJob.mockResolvedValue({ id: ID, status: 'to_schedule', quote_id: 'q1' });
  setJobStatus.mockResolvedValue({ id: ID, status: 'cancelled' });
  getInvoiceByJob.mockResolvedValue({ id: 'inv-1', status: 'draft' });
  setInvoiceStatus.mockResolvedValue({ id: 'inv-1', status: 'cancelled' });
  releaseAccrualOnCancelMock.mockResolvedValue({ released: false });
  // WT-31: not-prepped by default — the stock-reversal block below no-ops
  // unless a test opts a job into stockDecrementedAt.
  getJobWorkOrderMock.mockResolvedValue({
    job: { stockDecrementedAt: null, isTest: false },
    materials: { materials: [], unbound: [], totalLines: 0 },
  });
  sb = fakeSb();
  sbRef.current = sb.client;
});

describe('POST /api/jobs/[id]/cancel', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(req, ctx());
    expect(res.status).toBe(401);
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  it('404s when the job is missing', async () => {
    getJob.mockResolvedValueOnce(null);
    const res = await POST(req, ctx());
    expect(res.status).toBe(404);
  });

  it('409s when the job is already done (cannot cancel a completed job)', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'done', quote_id: 'q1' });
    const res = await POST(req, ctx());
    expect(res.status).toBe(409);
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  it('is a no-op when the job is already cancelled', async () => {
    getJob.mockResolvedValueOnce({ id: ID, status: 'cancelled', quote_id: 'q1' });
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.alreadyCancelled).toBe(true);
    expect(setJobStatus).not.toHaveBeenCalled();
  });

  it('cancels the job, its invoice, and the quote', async () => {
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.cancelled).toBe(true);
    expect(setJobStatus).toHaveBeenCalledWith(ID, 'cancelled');
    expect(setInvoiceStatus).toHaveBeenCalledWith('inv-1', 'cancelled');
    expect(sb.updates[0]).toMatchObject({ status: 'cancelled' }); // quote
  });

  // Referral program (#41 adversarial-review MED fix): a cancelled order
  // never happened, so any 'booked' referral accrual tied to it must reverse.
  // releaseAccrualOnCancel's OWN state-transition logic is unit-tested in
  // src/lib/referrals.test.ts; this file only proves the wiring + fail-open.
  describe('referral accrual reversal wiring (#41)', () => {
    it('calls releaseAccrualOnCancel with the cancelled quote id after the quote cancel commits', async () => {
      const res = await POST(req, ctx());
      expect(res.status).toBe(200);
      expect(releaseAccrualOnCancelMock).toHaveBeenCalledWith('q1');
    });

    it('does not call it when the job has no linked quote', async () => {
      getJob.mockResolvedValueOnce({ id: ID, status: 'to_schedule', quote_id: null });
      const res = await POST(req, ctx());
      expect(res.status).toBe(200);
      expect(releaseAccrualOnCancelMock).not.toHaveBeenCalled();
    });

    it('fails open — a rejected releaseAccrualOnCancel never breaks the cancel response', async () => {
      releaseAccrualOnCancelMock.mockRejectedValueOnce(new Error('referrals table missing'));
      const res = await POST(req, ctx());
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.cancelled).toBe(true);
      expect(json.quoteCancelled).toBe(true);
    });
  });

  it('flags a paid invoice for a manual refund', async () => {
    getInvoiceByJob.mockResolvedValueOnce({ id: 'inv-1', status: 'paid' });
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(json.refundedInvoice).toBe(true);
    expect(setInvoiceStatus).toHaveBeenCalledWith('inv-1', 'cancelled');
  });

  it('cancels job + quote even when there is no invoice yet', async () => {
    getInvoiceByJob.mockResolvedValueOnce(null);
    const res = await POST(req, ctx());
    expect(res.status).toBe(200);
    expect(setInvoiceStatus).not.toHaveBeenCalled();
    expect(sb.updates[0]).toMatchObject({ status: 'cancelled' }); // quote still cancelled
  });

  it('flags a DEPOSIT refund when a deposit was paid but no invoice exists yet', async () => {
    sb = fakeSb({ deposit_paid_at: '2026-01-01T00:00:00Z', deposit_amount_usd: 1467 }); // deposit paid
    sbRef.current = sb.client;
    getInvoiceByJob.mockResolvedValueOnce(null); // booked, not completed → no invoice
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(json.refundedDeposit).toBe(true);
    expect(json.refundNeeded).toBe(true);
    expect(setInvoiceStatus).not.toHaveBeenCalled();
  });

  // W1-008: cancelling a deposit-paid order must persist the refund obligation
  // (not just return it ephemerally) + alert staff, mirroring the deposit
  // webhook's "money event → durable record + email" pattern.
  describe('W1-008 — refund-due record + staff alert', () => {
    it('stamps approval_snapshot.refundDue (merged) and emails staff when a deposit was paid', async () => {
      sb = fakeSb({
        deposit_paid_at: '2026-01-01T00:00:00Z',
        deposit_amount_usd: 1467,
        result: { depositAmount: 1467 },
        customer_name: 'Jordan Smith',
        highlevel_contact_id: 'contact-1',
        approval_snapshot: { customerSelection: { currentTotalUsd: 2934 }, signature: 'sig-data' },
      });
      sbRef.current = sb.client;
      getInvoiceByJob.mockResolvedValueOnce(null);

      const res = await POST(req, ctx());
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.refundedDeposit).toBe(true);

      // updates[0] = quote status cancel; updates[1] = the refundDue snapshot merge.
      expect(sb.updates[0]).toMatchObject({ status: 'cancelled' });
      expect(sb.updates[1]).toMatchObject({
        approval_snapshot: {
          // existing keys preserved — never clobbered.
          customerSelection: { currentTotalUsd: 2934 },
          signature: 'sig-data',
          refundDue: { reason: 'cancelled-deposit-paid', amountUsd: 1467 },
        },
      });

      expect(hl.sendEmail).toHaveBeenCalledTimes(1);
      expect(hl.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          contactId: 'internal-1',
          subject: expect.stringContaining('Jordan Smith'),
        }),
      );
    });

    it('falls back to result.depositAmount when deposit_amount_usd is missing (legacy row)', async () => {
      sb = fakeSb({
        deposit_paid_at: '2026-01-01T00:00:00Z',
        deposit_amount_usd: null,
        result: { depositAmount: 900 },
        customer_name: 'Legacy Customer',
      });
      sbRef.current = sb.client;
      getInvoiceByJob.mockResolvedValueOnce(null);

      await POST(req, ctx());

      expect(sb.updates[1]).toMatchObject({
        approval_snapshot: { refundDue: { amountUsd: 900 } },
      });
    });

    it('does NOT stamp a refundDue marker or email when no deposit was paid', async () => {
      sb = fakeSb({ deposit_paid_at: null });
      sbRef.current = sb.client;

      const res = await POST(req, ctx());
      const json = await res.json();

      expect(json.refundedDeposit).toBe(false);
      // Only the one status-cancel update; no second refundDue write.
      expect(sb.updates).toHaveLength(1);
      expect(hl.sendEmail).not.toHaveBeenCalled();
    });

    it('does not fail the cancel when the staff alert email throws (best-effort)', async () => {
      sb = fakeSb({
        deposit_paid_at: '2026-01-01T00:00:00Z',
        deposit_amount_usd: 1467,
        customer_name: 'Jordan Smith',
      });
      sbRef.current = sb.client;
      hl.sendEmail.mockRejectedValueOnce(new Error('GHL down'));

      const res = await POST(req, ctx());
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.refundedDeposit).toBe(true);
    });
  });

  it('(#110 W6-010) surfaces a failed source-quote status write instead of an unqualified success', async () => {
    const b = sb.client as Record<string, unknown>;
    (b as { then: unknown }).then = (resolve: (v: unknown) => void) =>
      resolve({ error: { message: 'update failed' } });
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.quoteCancelled).toBe(false);
    expect(json.note).toMatch(/could not be updated/i);
  });

  // WT-17: a completed-then-cancelled order already collected the FULL balance
  // (deposit + remaining balance), not just the deposit — the refund owed +
  // durable record + staff alert must reflect the whole invoice total.
  describe('WT-17 — full-order refund when the invoice was already paid in full', () => {
    it('uses invoice.total (not the deposit) as the refund amount, and stamps + emails a full-order refund', async () => {
      sb = fakeSb({
        deposit_paid_at: '2026-01-01T00:00:00Z',
        deposit_amount_usd: 1467, // the original deposit — must NOT be used once paid in full
        customer_name: 'Jordan Smith',
        approval_snapshot: { customerSelection: { currentTotalUsd: 2934 } },
      });
      sbRef.current = sb.client;
      getInvoiceByJob.mockResolvedValueOnce({ id: 'inv-1', status: 'paid', total: 3200 });

      const res = await POST(req, ctx());
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.refundedInvoice).toBe(true);
      expect(json.refundedDeposit).toBe(true);
      expect(setInvoiceStatus).toHaveBeenCalledWith('inv-1', 'cancelled');

      // updates[0] = quote status cancel; updates[1] = the refundDue snapshot merge.
      expect(sb.updates[1]).toMatchObject({
        approval_snapshot: {
          customerSelection: { currentTotalUsd: 2934 }, // existing keys preserved
          refundDue: { reason: 'cancelled-paid-in-full', amountUsd: 3200 },
        },
      });

      expect(hl.sendEmail).toHaveBeenCalledTimes(1);
      const args = hl.sendEmail.mock.calls[0] as unknown as [{ html: string }];
      expect(args[0].html).toContain('$3,200.00');
      expect(args[0].html).toContain('the full order balance was already collected');
      expect(args[0].html).not.toContain('Deposit to refund');
    });

    it('still refunds the full invoice total even when no deposit was ever recorded on the quote', async () => {
      sb = fakeSb({ deposit_paid_at: null, customer_name: 'No Deposit On File' });
      sbRef.current = sb.client;
      getInvoiceByJob.mockResolvedValueOnce({ id: 'inv-1', status: 'paid', total: 1500 });

      const res = await POST(req, ctx());
      const json = await res.json();

      expect(json.refundedInvoice).toBe(true);
      expect(json.refundedDeposit).toBe(false);
      expect(json.refundNeeded).toBe(true);
      expect(sb.updates[1]).toMatchObject({
        approval_snapshot: { refundDue: { reason: 'cancelled-paid-in-full', amountUsd: 1500 } },
      });
      expect(hl.sendEmail).toHaveBeenCalledTimes(1);
    });
  });

  // WT-31: a job whose materials were already prepped (stock decremented at
  // prep — #82 Phase 2) must have that deduction reversed on cancel, or at
  // least a note if nothing trackable was found to reverse.
  describe('WT-31 — stock reversal on cancel', () => {
    it('reverses the on-hand deduction for a prepped job (stock_decremented_at set)', async () => {
      getJobWorkOrderMock.mockResolvedValueOnce({
        job: { stockDecrementedAt: '2026-01-05T00:00:00Z', isTest: false },
        materials: {
          materials: [
            { sku: 'SKU-A', name: 'Item A', qty: 5, onHand: 20, short: false },
            { sku: 'SKU-B', name: 'Item B', qty: 3, onHand: 1, short: true },
            { sku: 'SKU-UNTRACKED', name: 'Item C', qty: 2, onHand: null, short: false },
          ],
          unbound: [],
          totalLines: 3,
        },
      });

      const res = await POST(req, ctx());
      const json = await res.json();

      expect(res.status).toBe(200);
      // Positive delta = return to stock; the untracked SKU is never touched.
      expect(adjustOnHandAtomicMock).toHaveBeenCalledWith(sbRef.current, 'SKU-A', 5);
      expect(adjustOnHandAtomicMock).toHaveBeenCalledWith(sbRef.current, 'SKU-B', 1);
      expect(adjustOnHandAtomicMock).not.toHaveBeenCalledWith(
        expect.anything(),
        'SKU-UNTRACKED',
        expect.anything(),
      );
      expect(json.stockReturned).toEqual(
        expect.arrayContaining([
          { sku: 'SKU-A', qty: 5 },
          { sku: 'SKU-B', qty: 1 },
        ]),
      );
      expect(json.note).toMatch(/Returned to stock/);
    });

    it('is a no-op when the job was never prepped (stock_decremented_at null)', async () => {
      getJobWorkOrderMock.mockResolvedValueOnce({
        job: { stockDecrementedAt: null, isTest: false },
        materials: {
          materials: [{ sku: 'SKU-A', name: 'Item A', qty: 5, onHand: 20, short: false }],
          unbound: [],
          totalLines: 1,
        },
      });

      const res = await POST(req, ctx());
      const json = await res.json();

      expect(adjustOnHandAtomicMock).not.toHaveBeenCalled();
      expect(json.stockReturned).toEqual([]);
    });

    it('skips the real reversal for a TEST job even if it was marked prepped (never touched real stock)', async () => {
      getJobWorkOrderMock.mockResolvedValueOnce({
        job: { stockDecrementedAt: '2026-01-05T00:00:00Z', isTest: true },
        materials: {
          materials: [{ sku: 'SKU-A', name: 'Item A', qty: 5, onHand: 20, short: false }],
          unbound: [],
          totalLines: 1,
        },
      });

      const res = await POST(req, ctx());
      const json = await res.json();

      expect(adjustOnHandAtomicMock).not.toHaveBeenCalled();
      expect(json.stockReturned).toEqual([]);
    });

    it('falls back to a note when a prepped job has nothing trackable to reverse', async () => {
      getJobWorkOrderMock.mockResolvedValueOnce({
        job: { stockDecrementedAt: '2026-01-05T00:00:00Z', isTest: false },
        materials: {
          materials: [{ sku: 'SKU-UNTRACKED', name: 'Item C', qty: 2, onHand: null, short: false }],
          unbound: [],
          totalLines: 1,
        },
      });

      const res = await POST(req, ctx());
      const json = await res.json();

      expect(adjustOnHandAtomicMock).not.toHaveBeenCalled();
      expect(json.stockReturned).toEqual([]);
      expect(json.note).toMatch(/no trackable on-hand stock/i);
    });

    it('does not fail the cancel when the work-order read throws (best-effort)', async () => {
      getJobWorkOrderMock.mockRejectedValueOnce(new Error('read failed'));

      const res = await POST(req, ctx());
      const json = await res.json();

      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(json.stockReturned).toEqual([]);
    });
  });
});
