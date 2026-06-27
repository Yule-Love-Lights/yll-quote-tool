import { describe, it, expect } from 'vitest';
import { deriveQuoteStage, computeWorkflowBoard } from './workflowBoard';
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
    homeworks_sent_at: null,
    homeworks_signed_at: null,
    highlevel_contact_id: null,
    service_type: null,
    ...overrides,
  };
}

describe('deriveQuoteStage', () => {
  it('is draft when never sent or approved', () => {
    expect(deriveQuoteStage(mkQuote())).toBe('draft');
  });

  it('is awaiting_response when sent but not approved', () => {
    expect(deriveQuoteStage(mkQuote({ quote_sent_at: '2026-06-02T00:00:00Z' }))).toBe('awaiting_response');
  });

  it('is approved when approved, even if also sent', () => {
    expect(
      deriveQuoteStage(
        mkQuote({ quote_sent_at: '2026-06-02T00:00:00Z', customer_approved_at: '2026-06-03T00:00:00Z' }),
      ),
    ).toBe('approved');
  });

  it('is approved when approved without a send timestamp (offline close)', () => {
    expect(deriveQuoteStage(mkQuote({ customer_approved_at: '2026-06-03T00:00:00Z' }))).toBe('approved');
  });
});

describe('computeWorkflowBoard', () => {
  it('buckets quotes by stage with counts and summed totals', () => {
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
    ]);
    expect(board.quotes.draft).toEqual({ count: 2, totalUsd: 3000 });
    expect(board.quotes.awaitingResponse).toEqual({ count: 1, totalUsd: 1500 });
    expect(board.quotes.approved).toEqual({ count: 1, totalUsd: 3000 });
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
  });
});
