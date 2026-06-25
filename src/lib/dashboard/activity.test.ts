import { describe, it, expect } from 'vitest';
import { buildCustomerActivity, type ActivityQuote, type ViewEventRow } from './activity';

const quote = (over: Partial<ActivityQuote> & { id: string; created_at: string }): ActivityQuote => ({
  quote_sent_at: null,
  customer_approved_at: null,
  total: null,
  ...over,
});

describe('buildCustomerActivity', () => {
  it('returns [] for no quotes and no views', () => {
    expect(buildCustomerActivity([], [])).toEqual([]);
  });

  it('emits a single created event for a draft quote', () => {
    const ev = buildCustomerActivity([quote({ id: 'q1', created_at: '2026-06-24T10:00:00Z', total: 100 })], []);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'created', quoteId: 'q1', total: 100 });
  });

  it('emits created -> sent -> approved for a full lifecycle, newest first', () => {
    const ev = buildCustomerActivity(
      [
        quote({
          id: 'q1',
          created_at: '2026-06-24T10:00:00Z',
          quote_sent_at: '2026-06-24T14:00:00Z',
          customer_approved_at: '2026-06-25T09:00:00Z',
        }),
      ],
      [],
    );
    expect(ev.map((e) => e.kind)).toEqual(['approved', 'sent', 'created']);
  });

  it('merges view events and sorts the whole timeline newest first', () => {
    const ev = buildCustomerActivity(
      [quote({ id: 'q1', created_at: '2026-06-24T10:00:00Z', quote_sent_at: '2026-06-24T14:00:00Z', total: 50 })],
      [
        { quote_id: 'q1', viewed_at: '2026-06-25T09:26:00Z' },
        { quote_id: 'q1', viewed_at: '2026-06-24T15:00:00Z' },
      ],
    );
    expect(ev.map((e) => e.kind)).toEqual(['viewed', 'viewed', 'sent', 'created']);
    expect(ev[0].at).toBe('2026-06-25T09:26:00Z');
    // view events carry the quote's total
    expect(ev[0].total).toBe(50);
  });

  it('ignores view rows for quotes not in the set', () => {
    const ev = buildCustomerActivity(
      [quote({ id: 'q1', created_at: '2026-06-24T10:00:00Z' })],
      [{ quote_id: 'other', viewed_at: '2026-06-25T09:00:00Z' }],
    );
    expect(ev.every((e) => e.quoteId === 'q1')).toBe(true);
    expect(ev.some((e) => e.kind === 'viewed')).toBe(false);
  });

  it('breaks an exact-timestamp tie newest-stage-first (approved, viewed, sent, created)', () => {
    const t = '2026-06-24T12:00:00Z';
    const ev = buildCustomerActivity(
      [quote({ id: 'q1', created_at: t, quote_sent_at: t, customer_approved_at: t })],
      [{ quote_id: 'q1', viewed_at: t }],
    );
    expect(ev.map((e) => e.kind)).toEqual(['approved', 'viewed', 'sent', 'created']);
  });

  it('interleaves events across multiple quotes by timestamp', () => {
    const ev = buildCustomerActivity(
      [
        quote({ id: 'a', created_at: '2026-06-20T10:00:00Z' }),
        quote({ id: 'b', created_at: '2026-06-22T10:00:00Z' }),
      ],
      [{ quote_id: 'a', viewed_at: '2026-06-21T10:00:00Z' }],
    );
    expect(ev.map((e) => `${e.kind}:${e.quoteId}`)).toEqual([
      'created:b', // Jun 22
      'viewed:a', // Jun 21
      'created:a', // Jun 20
    ]);
  });
});
