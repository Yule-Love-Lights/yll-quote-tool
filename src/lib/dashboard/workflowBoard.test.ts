import { describe, it, expect } from 'vitest';
import { computeWorkflowBoard, type WorkflowJob, type WorkflowInvoice } from './workflowBoard';
import type { DashboardQuote } from './types';

function mkQuote(overrides: Partial<DashboardQuote> = {}): DashboardQuote {
  return {
    id: 'q1',
    customer_name: 'Test Customer',
    customer_email: null,
    customer_phone: null,
    total: 1000,
    created_at: '2026-06-01T00:00:00Z',
    quote_sent_at: null,
    customer_approved_at: null,
    deposit_paid_at: null,
    homeworks_sent_at: null,
    homeworks_signed_at: null,
    highlevel_contact_id: null,
    service_type: null,
    ...overrides,
  };
}

describe('computeWorkflowBoard', () => {
  it('buckets quotes by derived status with counts and summed totals', () => {
    const board = computeWorkflowBoard([
      mkQuote({ id: 'a', total: 1000 }),
      mkQuote({ id: 'b', total: 2000 }),
      mkQuote({ id: 'c', total: 1500, quote_sent_at: '2026-06-02T00:00:00Z' }),
      mkQuote({
        id: 'd',
        total: 3000,
        quote_sent_at: '2026-06-02T00:00:00Z',
        customer_approved_at: '2026-06-03T00:00:00Z',
      }),
      mkQuote({
        id: 'e',
        total: 4000,
        quote_sent_at: '2026-06-02T00:00:00Z',
        customer_approved_at: '2026-06-03T00:00:00Z',
        deposit_paid_at: '2026-06-04T00:00:00Z',
      }),
    ]);
    expect(board.quotes.draft).toEqual({ count: 2, totalUsd: 3000 });
    expect(board.quotes.awaitingResponse).toEqual({ count: 1, totalUsd: 1500 });
    expect(board.quotes.approved).toEqual({ count: 1, totalUsd: 3000 });
    expect(board.quotes.booked).toEqual({ count: 1, totalUsd: 4000 });
  });

  it('treats a null total as 0 in the sum', () => {
    const board = computeWorkflowBoard([mkQuote({ id: 'a', total: null })]);
    expect(board.quotes.draft).toEqual({ count: 1, totalUsd: 0 });
  });

  it('returns zeroed buckets for an empty list', () => {
    const board = computeWorkflowBoard([]);
    expect(board.quotes.draft).toEqual({ count: 0, totalUsd: 0 });
    expect(board.quotes.awaitingResponse).toEqual({ count: 0, totalUsd: 0 });
    expect(board.quotes.approved).toEqual({ count: 0, totalUsd: 0 });
    expect(board.quotes.booked).toEqual({ count: 0, totalUsd: 0 });
  });

  it('zeroes every jobs bucket when no jobs are passed', () => {
    const board = computeWorkflowBoard([mkQuote()]);
    expect(board.jobs.to_schedule).toEqual({ count: 0, totalUsd: 0 });
    expect(board.jobs.done).toEqual({ count: 0, totalUsd: 0 });
    expect(board.jobs.cancelled).toEqual({ count: 0, totalUsd: 0 });
  });
});

function mkJob(status: string | null, ...amounts: number[]): WorkflowJob {
  return { status, line_items: amounts.map((amount) => ({ amount })) };
}

describe('computeWorkflowBoard — cancelled orders excluded from booked bucket (B7)', () => {
  it('a cancelled order with deposit_paid_at does NOT count as booked', () => {
    const board = computeWorkflowBoard([
      mkQuote({
        id: 'cancelled-booked',
        total: 5000,
        quote_sent_at: '2026-06-02T00:00:00Z',
        customer_approved_at: '2026-06-03T00:00:00Z',
        deposit_paid_at: '2026-06-04T00:00:00Z',
        status: 'cancelled',
      }),
    ]);
    expect(board.quotes.booked).toEqual({ count: 0, totalUsd: 0 });
  });

  it('a cancelled order with customer_approved_at does NOT count as approved', () => {
    const board = computeWorkflowBoard([
      mkQuote({
        id: 'cancelled-approved',
        total: 3000,
        quote_sent_at: '2026-06-02T00:00:00Z',
        customer_approved_at: '2026-06-03T00:00:00Z',
        status: 'cancelled',
      }),
    ]);
    expect(board.quotes.approved).toEqual({ count: 0, totalUsd: 0 });
    // A cancelled quote should not inflate any forward-progress bucket
    expect(board.quotes.booked.count + board.quotes.approved.count + board.quotes.awaitingResponse.count).toBe(0);
  });

  it('declined and abandoned orders are also excluded from forward-progress buckets', () => {
    const board = computeWorkflowBoard([
      mkQuote({ id: 'd', total: 2000, quote_sent_at: '2026-06-02T00:00:00Z', status: 'declined' }),
      mkQuote({ id: 'l', total: 1500, quote_sent_at: '2026-06-02T00:00:00Z', status: 'abandoned' }),
    ]);
    // Neither should appear in awaitingResponse (even though they have quote_sent_at)
    expect(board.quotes.awaitingResponse).toEqual({ count: 0, totalUsd: 0 });
    expect(board.quotes.draft).toEqual({ count: 0, totalUsd: 0 });
    expect(board.quotes.booked).toEqual({ count: 0, totalUsd: 0 });
  });

  it('a non-cancelled booked order still counts correctly', () => {
    const board = computeWorkflowBoard([
      mkQuote({
        id: 'real-booked',
        total: 4000,
        quote_sent_at: '2026-06-02T00:00:00Z',
        customer_approved_at: '2026-06-03T00:00:00Z',
        deposit_paid_at: '2026-06-04T00:00:00Z',
        status: 'booked',
      }),
    ]);
    expect(board.quotes.booked).toEqual({ count: 1, totalUsd: 4000 });
  });
});

describe('computeWorkflowBoard — jobs column', () => {
  it('buckets jobs by billing status, summing line-item amounts for the total', () => {
    const board = computeWorkflowBoard(
      [],
      [
        mkJob('to_schedule', 1200, 300), // 1500
        mkJob('to_schedule', 500),
        mkJob('scheduled', 2000),
        mkJob('done', 4000),
      ],
    );
    expect(board.jobs.to_schedule).toEqual({ count: 2, totalUsd: 2000 });
    expect(board.jobs.scheduled).toEqual({ count: 1, totalUsd: 2000 });
    expect(board.jobs.done).toEqual({ count: 1, totalUsd: 4000 });
    expect(board.jobs.installed).toEqual({ count: 0, totalUsd: 0 });
  });

  it('treats an unknown/legacy/null job status as to_schedule (never drops a row)', () => {
    const board = computeWorkflowBoard([], [mkJob('bogus', 100), mkJob(null, 50)]);
    expect(board.jobs.to_schedule).toEqual({ count: 2, totalUsd: 150 });
  });

  it('treats null line_items as 0 in the job total', () => {
    const board = computeWorkflowBoard([], [{ status: 'scheduled', line_items: null }]);
    expect(board.jobs.scheduled).toEqual({ count: 1, totalUsd: 0 });
  });
});

function mkInvoice(status: string | null, balance: number | null): WorkflowInvoice {
  return { status, balance };
}

describe('computeWorkflowBoard — invoices column (#83 Phase 3 wired)', () => {
  it('zeroes every invoices bucket when no invoices are passed', () => {
    const board = computeWorkflowBoard([mkQuote()]);
    expect(board.invoices.draft).toEqual({ count: 0, totalUsd: 0 });
    expect(board.invoices.awaiting_payment).toEqual({ count: 0, totalUsd: 0 });
    expect(board.invoices.paid).toEqual({ count: 0, totalUsd: 0 });
    expect(board.invoices.cancelled).toEqual({ count: 0, totalUsd: 0 });
  });

  it('buckets invoices by status, summing the outstanding balance for the total', () => {
    const board = computeWorkflowBoard(
      [],
      [],
      [
        mkInvoice('draft', 1000),
        mkInvoice('awaiting_payment', 2500),
        mkInvoice('awaiting_payment', 500),
        mkInvoice('paid', 0),
        mkInvoice('cancelled', 800),
      ],
    );
    expect(board.invoices.draft).toEqual({ count: 1, totalUsd: 1000 });
    expect(board.invoices.awaiting_payment).toEqual({ count: 2, totalUsd: 3000 });
    expect(board.invoices.paid).toEqual({ count: 1, totalUsd: 0 });
    expect(board.invoices.cancelled).toEqual({ count: 1, totalUsd: 800 });
  });

  it('treats an unknown/legacy/null invoice status as draft (never drops a row)', () => {
    const board = computeWorkflowBoard([], [], [mkInvoice('bogus', 100), mkInvoice(null, 50)]);
    expect(board.invoices.draft).toEqual({ count: 2, totalUsd: 150 });
  });

  it('treats a null balance as 0 in the invoice total', () => {
    const board = computeWorkflowBoard([], [], [mkInvoice('awaiting_payment', null)]);
    expect(board.invoices.awaiting_payment).toEqual({ count: 1, totalUsd: 0 });
  });
});
