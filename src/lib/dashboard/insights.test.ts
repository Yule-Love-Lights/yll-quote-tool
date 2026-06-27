import { describe, it, expect } from 'vitest';
import { monthlyRevenue, revenueByService, computeInsightStats } from './insights';
import type { DashboardQuote } from './types';

const NOW = new Date('2026-06-15T12:00:00Z');

function makeQuote(over: Partial<DashboardQuote> = {}): DashboardQuote {
  return {
    id: crypto.randomUUID(),
    customer_name: 'Test',
    customer_email: null,
    customer_phone: null,
    total: 1000,
    created_at: '2026-06-01T12:00:00Z',
    quote_sent_at: null,
    customer_approved_at: null,
    deposit_paid_at: null,
    homeworks_sent_at: null,
    homeworks_signed_at: null,
    highlevel_contact_id: null,
    service_type: null,
    ...over,
  };
}

describe('monthlyRevenue', () => {
  it('returns exactly `months` buckets ending at the current month, in order', () => {
    const out = monthlyRevenue([], NOW, 12);
    expect(out).toHaveLength(12);
    expect(out[out.length - 1].key).toBe('2026-06'); // current month last
    expect(out[0].key).toBe('2025-07'); // 12 months back
    const keys = out.map(b => b.key);
    expect(keys).toEqual([...keys].sort()); // chronological
    expect(out.every(b => b.revenue === 0)).toBe(true);
  });

  it('sums approved totals into their APPROVAL month; ignores non-approved', () => {
    const out = monthlyRevenue(
      [
        makeQuote({ total: 1500, customer_approved_at: '2026-06-10T00:00:00Z' }),
        makeQuote({ total: 500, customer_approved_at: '2026-06-20T00:00:00Z' }),
        makeQuote({ total: 2000, customer_approved_at: '2026-04-05T00:00:00Z' }),
        makeQuote({ total: 9999, customer_approved_at: null }), // not approved
      ],
      NOW,
      12,
    );
    expect(out.find(b => b.key === '2026-06')!.revenue).toBe(2000);
    expect(out.find(b => b.key === '2026-04')!.revenue).toBe(2000);
  });

  it('ignores approvals outside the trailing window', () => {
    const out = monthlyRevenue(
      [makeQuote({ total: 5000, customer_approved_at: '2024-01-01T00:00:00Z' })],
      NOW,
      12,
    );
    expect(out.reduce((s, b) => s + b.revenue, 0)).toBe(0);
  });
});

describe('revenueByService', () => {
  it('splits booked revenue by service type (NULL = holiday); only approved', () => {
    const out = revenueByService([
      makeQuote({ service_type: 'holiday', total: 1000, customer_approved_at: '2026-06-01T00:00:00Z' }),
      makeQuote({ service_type: null, total: 500, customer_approved_at: '2026-06-01T00:00:00Z' }), // → holiday
      makeQuote({ service_type: 'permanent', total: 13000, customer_approved_at: '2026-06-01T00:00:00Z' }),
      makeQuote({ service_type: 'event', total: 4800, customer_approved_at: '2026-06-01T00:00:00Z' }),
      makeQuote({ service_type: 'event', total: 9999, customer_approved_at: null }), // not approved
    ]);
    const byKey = Object.fromEntries(out.map(s => [s.service, s.revenue]));
    expect(byKey.holiday).toBe(1500);
    expect(byKey.permanent).toBe(13000);
    expect(byKey.event).toBe(4800);
  });

  it('always returns all three services in canonical order, even at 0', () => {
    const out = revenueByService([]);
    expect(out.map(s => s.service)).toEqual(['holiday', 'permanent', 'event']);
    expect(out.every(s => s.revenue === 0)).toBe(true);
  });
});

describe('computeInsightStats', () => {
  it('closeRatio = approved / reached (sent-or-approved); never exceeds 1', () => {
    const s = computeInsightStats([
      makeQuote({ quote_sent_at: '2026-01-01T00:00:00Z', customer_approved_at: '2026-01-05T00:00:00Z' }),
      makeQuote({ quote_sent_at: '2026-02-01T00:00:00Z' }),
      makeQuote({ quote_sent_at: null, customer_approved_at: '2026-03-01T00:00:00Z' }), // approved-never-sent
    ]);
    expect(s.closeRatio).toBe(2 / 3); // 2 approved of 3 reached
    expect(s.closeRatio!).toBeLessThanOrEqual(1);
  });

  it('avgJobValue averages approved totals; avgQuoteValue averages all', () => {
    const s = computeInsightStats([
      makeQuote({ total: 1000, customer_approved_at: '2026-06-01T00:00:00Z' }),
      makeQuote({ total: 3000, customer_approved_at: '2026-06-01T00:00:00Z' }),
      makeQuote({ total: 500, customer_approved_at: null }),
    ]);
    expect(s.avgJobValue).toBe(2000); // (1000+3000)/2
    expect(s.avgQuoteValue).toBe(1500); // (1000+3000+500)/3
    expect(s.totalBooked).toBe(4000);
  });

  it('timeToCloseDays averages created→approved days', () => {
    const s = computeInsightStats([
      makeQuote({ created_at: '2026-06-01T00:00:00Z', customer_approved_at: '2026-06-05T00:00:00Z' }), // 4d
      makeQuote({ created_at: '2026-06-01T00:00:00Z', customer_approved_at: '2026-06-03T00:00:00Z' }), // 2d
    ]);
    expect(s.timeToCloseDays).toBe(3);
  });

  it('returns nulls when there is no data to average', () => {
    const s = computeInsightStats([makeQuote({ quote_sent_at: null })]);
    expect(s.closeRatio).toBeNull();
    expect(s.avgJobValue).toBeNull();
    expect(s.timeToCloseDays).toBeNull();
  });
});
