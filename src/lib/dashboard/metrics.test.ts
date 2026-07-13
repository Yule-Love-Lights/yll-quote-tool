import { describe, it, expect } from 'vitest';
import { computeKpis } from './metrics';
import { computeInsightStats } from './insights';
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
    deposit_paid_at: null,
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

describe('computeKpis — cancelled orders excluded from booked revenue (B7)', () => {
  it('a cancelled order with customer_approved_at does NOT count as booked revenue', () => {
    const k = computeKpis(
      [
        makeQuote({ total: 5000, customer_approved_at: '2026-06-01T00:00:00Z', status: 'cancelled' }),
        makeQuote({ total: 2000, customer_approved_at: '2026-06-01T00:00:00Z' }), // real booking
      ],
      NOW,
    );
    expect(k.bookedRevenue).toBe(2000); // only the non-cancelled one
  });

  it('a cancelled order with deposit_paid_at AND customer_approved_at does NOT inflate revenue', () => {
    const k = computeKpis(
      [
        makeQuote({
          total: 8000,
          customer_approved_at: '2026-06-01T00:00:00Z',
          deposit_paid_at: '2026-06-02T00:00:00Z',
          status: 'cancelled',
        }),
      ],
      NOW,
    );
    expect(k.bookedRevenue).toBe(0);
    expect(k.bookedRevenueRecent).toBe(0);
  });

  it('declined and lost orders also do NOT count as booked revenue', () => {
    const k = computeKpis(
      [
        makeQuote({ total: 3000, customer_approved_at: '2026-06-01T00:00:00Z', status: 'declined' }),
        makeQuote({ total: 4000, customer_approved_at: '2026-06-01T00:00:00Z', status: 'lost' }),
        makeQuote({ total: 1000, customer_approved_at: '2026-06-01T00:00:00Z' }), // real booking
      ],
      NOW,
    );
    expect(k.bookedRevenue).toBe(1000);
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

  it('keys on highlevel_contact_id ahead of email (same contact, different emails → one customer)', () => {
    const recentSent = new Date(NOW.getTime() - 1 * 86400_000).toISOString();
    const k = computeKpis(
      [
        makeQuote({ quote_sent_at: recentSent, highlevel_contact_id: 'h1', customer_email: 'a@x.com' }),
        makeQuote({ quote_sent_at: recentSent, highlevel_contact_id: 'h1', customer_email: 'b@x.com' }),
      ],
      NOW,
    );
    expect(k.activeCustomers).toBe(1); // contact id wins over the differing emails
  });

  it('keys on email ahead of phone (same email, different phones → one customer)', () => {
    const recentSent = new Date(NOW.getTime() - 1 * 86400_000).toISOString();
    const k = computeKpis(
      [
        makeQuote({ quote_sent_at: recentSent, customer_email: 'a@x.com', customer_phone: '555-0001' }),
        makeQuote({ quote_sent_at: recentSent, customer_email: 'a@x.com', customer_phone: '555-0002' }),
      ],
      NOW,
    );
    expect(k.activeCustomers).toBe(1); // email wins over the differing phones
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

  it('conversion rate = approved / reached (sent-or-approved) across all-time', () => {
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

  it('stays in [0,1] when a quote is approved but was never marked sent (offline close)', () => {
    // /approve stamps customer_approved_at WITHOUT quote_sent_at. The old
    // approved/sent ratio produced 2.0 (200%) here — regression guard.
    const k = computeKpis(
      [
        makeQuote({ quote_sent_at: '2026-01-01T00:00:00Z', customer_approved_at: '2026-01-05T00:00:00Z' }),
        makeQuote({ quote_sent_at: null, customer_approved_at: '2026-02-01T00:00:00Z' }), // approved, never sent
      ],
      NOW,
    );
    expect(k.conversionRate).toBe(1); // 2 reached, 2 approved → 1.0, not 2.0
    expect(k.conversionRate).toBeLessThanOrEqual(1);
  });

  it('conversion is null when no quote has reached a customer', () => {
    const k = computeKpis([makeQuote({ quote_sent_at: null })], NOW);
    expect(k.conversionRate).toBeNull();
  });
});

// WT-48: dashboard Conversion (computeKpis) and Insights Close ratio
// (computeInsightStats) used to compute the sent-or-approved "reached"
// denominator differently — Insights gated it on the terminal-filtered
// "approved" flag, so an approved-then-cancelled quote with no sent stamp
// silently dropped out of its ratio while still counting for Conversion.
// Both now share serviceMetrics.ts's reachedCustomer(); this proves parity.
describe('Conversion (metrics.ts) / Close-ratio (insights.ts) parity — WT-48', () => {
  it('computes the identical ratio on the same data, including an approved-then-cancelled quote with no sent stamp', () => {
    const quotes: DashboardQuote[] = [
      // sent + approved, not terminal — a real win.
      makeQuote({ quote_sent_at: '2026-01-01T00:00:00Z', customer_approved_at: '2026-01-05T00:00:00Z' }),
      // sent, never approved — reached, not won.
      makeQuote({ quote_sent_at: '2026-02-01T00:00:00Z' }),
      // approved then cancelled, never marked sent (offline close that fell
      // through). Still reached the customer — they approved it — even
      // though it's not a win and quote_sent_at is null.
      makeQuote({ quote_sent_at: null, customer_approved_at: '2026-03-01T00:00:00Z', status: 'cancelled' }),
    ];
    const k = computeKpis(quotes, NOW);
    const s = computeInsightStats(quotes);
    expect(k.conversionRate).toBe(1 / 3); // 1 won / 3 reached
    expect(s.closeRatio).toBe(1 / 3);
    expect(k.conversionRate).toBe(s.closeRatio);
  });
});
