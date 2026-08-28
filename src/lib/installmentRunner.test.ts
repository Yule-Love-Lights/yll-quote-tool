import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// Only the two IO seams are replaced; isOverdue / reconcilePlan stay REAL, so
// the pure-planner suites below still exercise the shipped policy.
const { listInstallmentPlans, markInstallmentPaid, getSupabaseServiceClient } = vi.hoisted(() => ({
  listInstallmentPlans: vi.fn(),
  markInstallmentPaid: vi.fn(),
  getSupabaseServiceClient: vi.fn(),
}));
vi.mock('@/lib/installments', async () => {
  const actual = await vi.importActual<typeof import('./installments')>('./installments');
  return { ...actual, listInstallmentPlans, markInstallmentPaid };
});
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient }));
import {
  planInstallmentRun,
  invoiceDriftBlockers,
  runSummaryMessage,
  runInstallments,
  isInstallmentRunnerEnabled,
  MAX_INSTALLMENT_CHARGE_USD,
  type RunResult,
} from './installmentRunner';
import type { Installment, InstallmentPlan } from './installments';

const inst = (over: Partial<Installment> & { seq: number }): Installment => ({
  id: `i-${over.seq}`,
  quoteId: 'q-1',
  amountUsd: 453.13,
  dueDate: null,
  dueOnCompletion: false,
  paidAt: null,
  paidSource: null,
  valorTxnId: null,
  note: null,
  ...over,
});

/** A plan whose quote and schedule agree, so `reconcilePlan` is quiet unless a
 *  test deliberately breaks it. */
const plan = (installments: Installment[], over: Partial<InstallmentPlan> = {}): InstallmentPlan => {
  const planPaid = installments.filter((i) => i.paidAt).reduce((a, i) => a + i.amountUsd, 0);
  const planOutstanding = installments.filter((i) => !i.paidAt).reduce((a, i) => a + i.amountUsd, 0);
  return {
    quoteId: 'q-1',
    quoteNumber: 1315,
    customerName: 'Jane Laguerre',
    customerEmail: 'jane@example.com',
    quoteTotal: 1000 + planOutstanding,
    collected: 1000 + planPaid,
    balance: planOutstanding,
    installments,
    planTotal: planPaid + planOutstanding,
    planPaid,
    planOutstanding,
    initialDeposit: 1000,
    hasCardOnFile: true,
    quoteStatus: 'booked',
    isNce: false,
    amendmentBlocksSettlement: false,
    ...over,
  };
};

/** 2026-09-06 09:00 ET — the day after Jane's 5 September payment. */
const AFTER_SEP_5 = new Date('2026-09-06T13:00:00Z');

describe('planInstallmentRun — the happy path', () => {
  it('charges the oldest dated payment that is due, and nothing else', () => {
    const [d] = planInstallmentRun(
      [plan([inst({ seq: 1, dueDate: '2026-08-05', paidAt: '2026-08-05T12:00:00Z' }), inst({ seq: 2, dueDate: '2026-09-05' }), inst({ seq: 3, dueDate: '2026-10-05' })])],
      AFTER_SEP_5,
    );
    expect(d.action).toBe('charge');
    expect(d.reasons).toEqual([]);
    expect(d.seq).toBe(2);
    expect(d.amountUsd).toBe(453.13);
    expect(d.alsoDue).toBe(0);
  });

  it('takes ONE payment per quote per run and reports the backlog rather than charging it', () => {
    const [d] = planInstallmentRun(
      [plan([inst({ seq: 1, dueDate: '2026-07-05' }), inst({ seq: 2, dueDate: '2026-08-05' }), inst({ seq: 3, dueDate: '2026-09-05' })])],
      AFTER_SEP_5,
    );
    expect(d.action).toBe('charge');
    expect(d.seq).toBe(1);
    expect(d.alsoDue).toBe(2);
  });

  it('never targets a due-on-completion payment, even when it is the only one left', () => {
    const [d] = planInstallmentRun([plan([inst({ seq: 3, dueOnCompletion: true, dueDate: null })])], AFTER_SEP_5);
    expect(d.action).toBe('skip');
    expect(d.reasons).toEqual(['nothing-due']);
    expect(d.installmentId).toBeNull();
  });

  it('reports nothing-due when the next payment is still in the future', () => {
    const [d] = planInstallmentRun([plan([inst({ seq: 4, dueDate: '2026-10-05' })])], AFTER_SEP_5);
    expect(d.reasons).toEqual(['nothing-due']);
  });
});

describe('planInstallmentRun — the ET business day (row 449)', () => {
  // 2026-09-05T01:00Z is 2026-09-04 at 9pm ET. A payment due 2026-09-05 is NOT
  // yet due. Comparing UTC calendar days (the pre-449 behaviour) would read
  // '2026-09-05' <= '2026-09-05' and charge a day early — this is the negative
  // control for that fix, and it fails if isOverdue goes back to toISOString().
  const NINE_PM_ET_SEP_4 = new Date('2026-09-05T01:00:00Z');

  it('does not charge the evening before the due date', () => {
    const [d] = planInstallmentRun([plan([inst({ seq: 4, dueDate: '2026-09-05' })])], NINE_PM_ET_SEP_4);
    expect(d.action).toBe('skip');
    expect(d.reasons).toEqual(['nothing-due']);
  });

  it('charges once the ET day actually arrives', () => {
    const [d] = planInstallmentRun([plan([inst({ seq: 4, dueDate: '2026-09-05' })])], new Date('2026-09-05T13:00:00Z'));
    expect(d.action).toBe('charge');
  });
});

describe('planInstallmentRun — the blockers', () => {
  const due = () => [inst({ seq: 4, dueDate: '2026-09-05' })];

  it('refuses without a card on file', () => {
    const [d] = planInstallmentRun([plan(due(), { hasCardOnFile: false })], AFTER_SEP_5);
    expect(d.action).toBe('skip');
    expect(d.reasons).toContain('no-card-on-file');
  });

  it('refuses a quote that is not booked', () => {
    const [d] = planInstallmentRun([plan(due(), { quoteStatus: 'dead' })], AFTER_SEP_5);
    expect(d.reasons).toContain('quote-not-booked');
    expect(d.detail).toContain("'dead'");
  });

  it('refuses an NCE trade job', () => {
    const [d] = planInstallmentRun([plan(due(), { isNce: true })], AFTER_SEP_5);
    expect(d.reasons).toContain('nce-quote');
  });

  it('refuses while a price increase is awaiting re-approval', () => {
    const [d] = planInstallmentRun([plan(due(), { amendmentBlocksSettlement: true })], AFTER_SEP_5);
    expect(d.reasons).toContain('amendment-pending');
  });

  it('refuses when the plan and the quote disagree about what is owed', () => {
    // balance says $100 is owed, the schedule says $453.13.
    const [d] = planInstallmentRun([plan(due(), { balance: 100 })], AFTER_SEP_5);
    expect(d.reasons).toContain('plan-out-of-step');
    expect(d.detail).toContain('plan outstanding');
  });

  it('refuses an amount over the automated ceiling', () => {
    const [d] = planInstallmentRun(
      [plan([inst({ seq: 4, dueDate: '2026-09-05', amountUsd: MAX_INSTALLMENT_CHARGE_USD + 0.01 })])],
      AFTER_SEP_5,
    );
    expect(d.reasons).toContain('over-cap');
  });

  it('reports EVERY blocker, not just the first', () => {
    const [d] = planInstallmentRun(
      [plan(due(), { hasCardOnFile: false, quoteStatus: 'dead', isNce: true })],
      AFTER_SEP_5,
    );
    expect(d.reasons).toEqual(expect.arrayContaining(['quote-not-booked', 'nce-quote', 'no-card-on-file']));
  });
});

describe('planInstallmentRun — the charge slot', () => {
  const dueAt = (valorTxnId: string | null) => [inst({ seq: 4, dueDate: '2026-09-05', valorTxnId })];

  it('refuses to re-charge a payment that already carries a real Valor txn id', () => {
    const [d] = planInstallmentRun([plan(dueAt('TXN-9911'))], AFTER_SEP_5);
    expect(d.action).toBe('skip');
    expect(d.reasons).toContain('charged-not-recorded');
    expect(d.detail).toContain('TXN-9911');
  });

  it('stands off a claim that is still fresh', () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    const [d] = planInstallmentRun([plan(dueAt(`pending:${fresh}`))], AFTER_SEP_5);
    expect(d.reasons).toContain('already-charging');
  });

  it('reclaims a claim left behind by a crashed run', () => {
    const stale = new Date(Date.now() - 60 * 60_000).toISOString();
    const [d] = planInstallmentRun([plan(dueAt(`pending:${stale}`))], AFTER_SEP_5);
    expect(d.action).toBe('charge');
    expect(d.reasons).toEqual([]);
  });
});

describe('invoiceDriftBlockers', () => {
  const inv = (over: Partial<{ id: string; quote_id: string | null; invoice_number: number | null; status: string }> = {}) => ({
    id: 'inv-1',
    quote_id: 'q-1',
    invoice_number: 1010,
    status: 'draft',
    ...over,
  });

  it('blocks a draft invoice, naming it', () => {
    const blocked = invoiceDriftBlockers([inv()]);
    expect(blocked.get('q-1')).toContain('#1010');
    expect(blocked.get('q-1')).toContain('row 446');
  });

  it('blocks an awaiting_payment invoice', () => {
    expect(invoiceDriftBlockers([inv({ status: 'awaiting_payment' })]).has('q-1')).toBe(true);
  });

  it('does not block a settled or cancelled invoice', () => {
    expect(invoiceDriftBlockers([inv({ status: 'paid' })]).size).toBe(0);
    expect(invoiceDriftBlockers([inv({ status: 'cancelled' })]).size).toBe(0);
  });

  it('ignores an invoice with no linked quote', () => {
    expect(invoiceDriftBlockers([inv({ quote_id: null })]).size).toBe(0);
  });
});

describe('runSummaryMessage', () => {
  const base = { quoteId: 'q-1', quoteNumber: 1315, customerName: 'Jane Laguerre', installmentId: 'i-4', seq: 4, amountUsd: 453.13 };

  it('says nothing on a quiet day', () => {
    const r: RunResult = { ok: true, dryRun: false, today: '2026-09-06', decisions: [], outcomes: [] };
    expect(runSummaryMessage(r)).toBeNull();
  });

  it('names the customer and amount on a charge', () => {
    const r: RunResult = {
      ok: true, dryRun: false, today: '2026-09-06', decisions: [],
      outcomes: [{ ...base, status: 'charged', txnId: 'TXN-1', message: null }],
    };
    const msg = runSummaryMessage(r)!;
    expect(msg).toContain('Jane Laguerre');
    expect(msg).toContain('453.13');
  });

  it('shouts about a charge that was not recorded', () => {
    const r: RunResult = {
      ok: true, dryRun: false, today: '2026-09-06', decisions: [],
      outcomes: [{ ...base, status: 'charged-not-recorded', txnId: 'TXN-1', message: 'recording failed' }],
    };
    expect(runSummaryMessage(r)!).toContain('PROBLEM (charged-not-recorded)');
  });

  it('reports a failed run', () => {
    expect(runSummaryMessage({ ok: false, error: 'Supabase down' })).toContain('Supabase down');
  });
});

describe('isInstallmentRunnerEnabled', () => {
  afterEach(() => {
    delete process.env.INSTALLMENT_RUNNER_ENABLED;
  });

  it('is off when unset', () => {
    expect(isInstallmentRunnerEnabled()).toBe(false);
  });

  it('is off for any value that is not an explicit yes', () => {
    for (const v of ['', 'false', '0', 'no', 'off', 'maybe']) {
      process.env.INSTALLMENT_RUNNER_ENABLED = v;
      expect(isInstallmentRunnerEnabled(), v).toBe(false);
    }
  });

  it('is on for the same set isAutoChargeEnabled accepts', () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE', ' On ']) {
      process.env.INSTALLMENT_RUNNER_ENABLED = v;
      expect(isInstallmentRunnerEnabled(), v).toBe(true);
    }
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// The wiring. The planner above is pure and well covered; what these prove is
// that its verdicts actually reach the charge path — the inert-fix class, where
// a guard is computed and no caller ever consults it.

describe('runInstallments — the invoice-drift gate is actually wired', () => {
  const dueNow = () => plan([inst({ seq: 4, dueDate: '2026-09-05' })]);

  function db(invoiceRows: unknown[]) {
    return {
      from: (table: string) => {
        if (table === 'invoices') {
          return { select: () => ({ in: async () => ({ data: invoiceRows, error: null }) }) };
        }
        throw new Error(`unexpected table ${table}`);
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    getSupabaseServiceClient.mockReturnValue(db([]));
    listInstallmentPlans.mockResolvedValue({ ok: true, plans: [dueNow()] });
  });

  it('turns a would-be charge into a skip when the linked invoice is still open', async () => {
    getSupabaseServiceClient.mockReturnValue(
      db([{ id: 'inv-1', quote_id: 'q-1', invoice_number: 1010, status: 'draft' }]),
    );
    const res = await runInstallments({ asOf: AFTER_SEP_5, dryRun: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.decisions[0]!.action).toBe('skip');
    expect(res.decisions[0]!.reasons).toContain('linked-invoice-would-drift');
    expect(res.decisions[0]!.detail).toContain('#1010');
  });

  it('leaves the charge standing when there is no open invoice to lie', async () => {
    const res = await runInstallments({ asOf: AFTER_SEP_5, dryRun: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.decisions[0]!.action).toBe('charge');
  });

  it('charges NOTHING on a dry run, however chargeable the plan is', async () => {
    const res = await runInstallments({ asOf: AFTER_SEP_5, dryRun: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.decisions[0]!.action).toBe('charge');
    expect(res.outcomes).toEqual([]);
    expect(markInstallmentPaid).not.toHaveBeenCalled();
  });

  it('reports the load failure rather than charging blind', async () => {
    listInstallmentPlans.mockResolvedValue({ ok: false, error: 'Supabase service role not configured' });
    const res = await runInstallments({ asOf: AFTER_SEP_5, dryRun: false });
    expect(res.ok).toBe(false);
    expect(markInstallmentPaid).not.toHaveBeenCalled();
  });
});
