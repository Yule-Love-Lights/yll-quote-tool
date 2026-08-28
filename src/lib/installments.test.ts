import { describe, it, expect } from 'vitest';
import { nextDuePayment, isOverdue, reconcilePlan, type InstallmentPlan, type Installment } from './installments';

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

const plan = (installments: Installment[], over: Partial<InstallmentPlan> = {}): InstallmentPlan => ({
  quoteId: 'q-1',
  quoteNumber: 1315,
  customerName: 'Jane Laguerre',
  customerEmail: 'jane@example.com',
  quoteTotal: 5452.5,
  collected: 4093.14,
  balance: 1359.36,
  installments,
  planTotal: 2718.75,
  planPaid: 1359.39,
  planOutstanding: 1359.36,
  initialDeposit: 2733.75,
  hasCardOnFile: false,
  quoteStatus: 'booked',
  isNce: false,
  amendmentBlocksSettlement: false,
  ...over,
});

describe('nextDuePayment', () => {
  it('returns the earliest unpaid DATED payment', () => {
    const p = plan([
      inst({ seq: 1, dueDate: '2026-06-13', paidAt: '2026-06-16T12:00:00Z' }),
      inst({ seq: 5, dueDate: '2026-10-05' }),
      inst({ seq: 4, dueDate: '2026-09-05' }),
    ]);
    expect(nextDuePayment(p)?.seq).toBe(4);
  });

  // A due-on-completion payment has no date, and auto-charging one on a date
  // would bill a customer before their install. It must never be "next".
  it('never returns a due-on-completion payment, even when it is the only one left', () => {
    const p = plan([
      inst({ seq: 1, dueDate: '2026-07-15', paidAt: '2026-07-15T12:00:00Z' }),
      inst({ seq: 3, dueOnCompletion: true, amountUsd: 184.16 }),
    ]);
    expect(nextDuePayment(p)).toBeNull();
  });

  // The test above passes even WITHOUT the dueOnCompletion check, because a
  // due-on-completion row has a null date and the date check alone excludes it
  // — a mutation probe caught that it pinned nothing. This one gives the row
  // BOTH flags, which the DB's installments_due_shape constraint forbids, so
  // it fails the moment the dueOnCompletion filter is removed. The guard is
  // defence in depth against a row that somehow reaches the code with that
  // shape; this is what makes it a guard rather than a hopeful comment.
  it('refuses a due-on-completion payment even if it somehow carries a date', () => {
    const p = plan([inst({ seq: 6, dueOnCompletion: true, dueDate: '2026-09-05', amountUsd: 278.4 })]);
    expect(nextDuePayment(p)).toBeNull();
  });

  it('returns null when every payment is settled', () => {
    expect(nextDuePayment(plan([inst({ seq: 1, dueDate: '2026-06-13', paidAt: '2026-06-16T12:00:00Z' })]))).toBeNull();
  });
});

describe('isOverdue', () => {
  const asOf = new Date('2026-09-10T12:00:00Z');

  it('is true for an unpaid dated payment whose date has passed', () => {
    expect(isOverdue(inst({ seq: 4, dueDate: '2026-09-05' }), asOf)).toBe(true);
  });

  it('is true on the due date itself', () => {
    expect(isOverdue(inst({ seq: 4, dueDate: '2026-09-10' }), asOf)).toBe(true);
  });

  it('is false for a future payment, a paid one, or one due on completion', () => {
    expect(isOverdue(inst({ seq: 5, dueDate: '2026-10-05' }), asOf)).toBe(false);
    expect(isOverdue(inst({ seq: 1, dueDate: '2026-06-13', paidAt: '2026-06-16T12:00:00Z' }), asOf)).toBe(false);
    expect(isOverdue(inst({ seq: 6, dueOnCompletion: true }), asOf)).toBe(false);
  });
});

describe('reconcilePlan', () => {
  it('returns null when the plan and the quote agree on what is owed', () => {
    expect(reconcilePlan(plan([]))).toBeNull();
  });

  // The invariant this exists to protect: markInstallmentPaid moves the
  // installment AND the quote's collected total together. If those ever drift,
  // the page says so instead of showing two different numbers as if both were
  // right.
  it('reports the difference when they disagree', () => {
    const drifted = plan([], { balance: 1359.36, planOutstanding: 906.23 });
    expect(reconcilePlan(drifted)).toBe('quote balance 1359.36 vs plan outstanding 906.23 (+453.13)');
  });

  it('tolerates sub-cent float noise rather than crying wolf', () => {
    expect(reconcilePlan(plan([], { balance: 1359.36, planOutstanding: 1359.3600000001 }))).toBeNull();
  });
});
