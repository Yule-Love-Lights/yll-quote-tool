import { describe, it, expect } from 'vitest';
import { computeKpis } from './metrics';
import type { DashboardQuote } from './types';
import { DASHBOARD_CONFIG } from './config';

// Fixed "now" for deterministic time math.
const NOW = new Date('2026-06-24T12:00:00Z');

function makeQuote(over: Partial<DashboardQuote> = {}): DashboardQuote {
  return {
    id: crypto.randomUUID(),
    customer_name: 'Test',
    customer_email: null,
    customer_phone: null,
    total: 1000,
    created_at: '2026-06-20T12:00:00Z',
    quote_sent_at: null,
    customer_approved_at: null,
    homeworks_sent_at: null,
    homeworks_signed_at: null,
    highlevel_contact_id: null,
    service_type: null,
    ...over,
  };
}

describe('computeKpis — empty', () => {
  it('returns all zeros / nulls on an empty list', () => {
    const k = computeKpis([], NOW);
    expect(k.bookedRevenue).toBe(0);
    expect(k.bookedRevenueRecent).toBe(0);
    expect(k.activeQuotes).toBe(0);
    expect(k.activeCustomers).toBe(0);
    expect(k.avgTurnaroundDays).toBeNull();
    expect(k.conversionRate).toBeNull();
  });
});

describe('computeKpis — booked revenue', () => {
  it('sums total only for approved quotes', () => {
    const k = computeKpis(
      [
        makeQuote({ total: 1500, customer_approved_at: '2026-06-01T00:00:00Z' }),
        makeQuote({ total: 2000, customer_approved_at: '2025-01-01T00:00:00Z' }),
        makeQuote({ total: 9999, customer_approved_at: null }), // not approved, ignored
      ],
      NOW,
    );
    expect(k.bookedRevenue).toBe(3500);
  });

  it('treats null totals as 0', () => {
    const k = computeKpis(
      [makeQuote({ total: null, customer_approved_at: '2026-06-01T00:00:00Z' })],
      NOW,
    );
    expect(k.bookedRevenue).toBe(0);
  });

  it('booked-recent uses only approvals within the configured window', () => {
    const withinWindow = new Date(NOW.getTime() - 10 * 86400_000).toISOString();
    const outsideWindow = new Date(
      NOW.getTime() - (DASHBOARD_CONFIG.recentlyBookedWindowDays + 5) * 86400_000,
    ).toISOString();
    const k = computeKpis(
      [
        makeQuote({ total: 800, customer_approved_at: withinWindow }),
        makeQuote({ total: 1200, customer_approved_at: outsideWindow }),
      ],
      NOW,
    );
    expect(k.bookedRevenueRecent).toBe(800);
    expect(k.bookedRevenue).toBe(2000); // lifetime ignores window
  });
});

describe('computeKpis — active quotes / customers', () => {
  it('counts only sent-but-not-approved quotes within the active window as active', () => {
    const recentSent = new Date(NOW.getTime() - 5 * 86400_000).toISOString();
    const oldSent = new Date(
      NOW.getTime() - (DASHBOARD_CONFIG.activeQuoteWindowDays + 5) * 86400_000,
    ).toISOString();
    const k = computeKpis(
      [
        makeQuote({ quote_sent_at: recentSent }),                                          // active
        makeQuote({ quote_sent_at: recentSent, customer_approved_at: '2026-06-20T00:00:00Z' }), // approved → not active
        makeQuote({ quote_sent_at: oldSent }),                                             // outside window → not active
        makeQuote({ quote_sent_at: null }),                                                // never sent → not active
      ],
      NOW,
    );
    expect(k.activeQuotes).toBe(1);
  });

  it('dedupes active customers by highlevel_contact_id, then email, then phone, then name', () => {
    const recentSent = new Date(NOW.getTime() - 1 * 86400_000).toISOString();
    const k = computeKpis(
      [
        makeQuote({ quote_sent_at: recentSent, highlevel_contact_id: 'hl1' }),
        makeQuote({ quote_sent_at: recentSent, highlevel_contact_id: 'hl1' }), // same contact → 1
        makeQuote({ quote_sent_at: recentSent, customer_email: 'a@x.com' }),
        makeQuote({ quote_sent_at: recentSent, customer_email: 'a@x.com' }),    // same email → 1
        makeQuote({ quote_sent_at: recentSent, customer_phone: '555-0100' }),
        makeQuote({ quote_sent_at: recentSent, customer_name: 'Solo' }),
      ],
      NOW,
    );
    expect(k.activeCustomers).toBe(4); // hl1, a@x.com, 555-0100, Solo
  });
});

describe('computeKpis — turnaround + conversion', () => {
  it('avg turnaround averages (sent - created) in days across sent quotes', () => {
    const k = computeKpis(
      [
        // 2 days
        makeQuote({ created_at: '2026-06-01T00:00:00Z', quote_sent_at: '2026-06-03T00:00:00Z' }),
        // 4 days
        makeQuote({ created_at: '2026-06-10T00:00:00Z', quote_sent_at: '2026-06-14T00:00:00Z' }),
        // not sent — ignored
        makeQuote({ created_at: '2026-06-20T00:00:00Z' }),
      ],
      NOW,
    );
    expect(k.avgTurnaroundDays).toBe(3);
  });

  it('returns null turnaround when no quote has been sent', () => {
    const k = computeKpis([makeQuote({ quote_sent_at: null })], NOW);
    expect(k.avgTurnaroundDays).toBeNull();
  });

  it('conversion rate = approved / sent across all-time', () => {
    const k = computeKpis(
      [
        makeQuote({ quote_sent_at: '2026-01-01T00:00:00Z', customer_approved_at: '2026-01-05T00:00:00Z' }),
        makeQuote({ quote_sent_at: '2026-02-01T00:00:00Z' }),
        makeQuote({ quote_sent_at: '2026-03-01T00:00:00Z', customer_approved_at: '2026-03-05T00:00:00Z' }),
        makeQuote({ quote_sent_at: '2026-04-01T00:00:00Z' }),
      ],
      NOW,
    );
    expect(k.conversionRate).toBe(0.5);
  });

  it('conversion is null when no quote has been sent', () => {
    const k = computeKpis([makeQuote({ quote_sent_at: null })], NOW);
    expect(k.conversionRate).toBeNull();
  });
});
