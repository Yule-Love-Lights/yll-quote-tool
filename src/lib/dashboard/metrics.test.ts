import { describe, it, expect } from 'vitest';
import { computeKpis, reached, customerKey } from './metrics';
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

describe('customerKey — identity grouping', () => {
  // Same E.164-vs-10-digit split fixed on the other identity paths (S42): GHL
  // stores '+16315550100', forms store '6315550100'. Left raw, one person
  // counted as two customers — inflating the active-customer KPI and splitting
  // the Customers list.
  it('groups an E.164 and a 10-digit phone as ONE customer', () => {
    const a = customerKey(makeQuote({ customer_name: null, customer_phone: '+16315550100' }));
    const b = customerKey(makeQuote({ customer_name: null, customer_phone: '(631) 555-0100' }));
    expect(a).toBe(b);
  });

  it('does NOT collapse a longer international number onto a US one', () => {
    const us = customerKey(makeQuote({ customer_name: null, customer_phone: '6315550100' }));
    const mx = customerKey(makeQuote({ customer_name: null, customer_phone: '+526315550100' }));
    expect(us).not.toBe(mx);
  });

  it('keeps the hl > email > phone > name precedence', () => {
    expect(customerKey(makeQuote({ highlevel_contact_id: 'hl_1', customer_phone: '6315550100' }))).toBe('hl_1');
    expect(customerKey(makeQuote({ customer_email: 'a@b.com', customer_phone: '6315550100' }))).toBe('a@b.com');
    // a phone with no digits falls through to name (normalized to lowercase)
    expect(customerKey(makeQuote({ customer_name: 'Jo', customer_email: null, customer_phone: 'n/a' }))).toBe('jo');
  });

  // Email is normalized the same way customerMatchKey (lib/customers.ts) does —
  // trimmed + lowercased — so 'A@B.com', 'a@b.com', and ' a@b.com ' are ONE
  // customer, not three. Left raw it split the same way phone used to.
  it('normalizes email case + whitespace so one person groups once', () => {
    const a = customerKey(makeQuote({ customer_email: 'A@B.com' }));
    const b = customerKey(makeQuote({ customer_email: 'a@b.com' }));
    const c = customerKey(makeQuote({ customer_email: '  a@b.com  ' }));
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(b).toBe('a@b.com');
  });

  // The name-only fallback tier (no hl id / email / phone) is normalized the
  // same way customerMatchKey normalizes its name — trimmed + lowercased — so
  // 'John Smith' and 'john smith ' are ONE customer, not two.
  it('normalizes name case + whitespace in the name-fallback tier', () => {
    const a = customerKey(makeQuote({ customer_name: 'John Smith', customer_email: null, customer_phone: null }));
    const b = customerKey(makeQuote({ customer_name: 'john smith ', customer_email: null, customer_phone: null }));
    expect(a).toBe(b);
    expect(a).toBe('john smith');
  });
});

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

  it('WT-48: an approved-but-terminal quote that was never sent is NOT counted as reached', () => {
    // Before WT-48, computeKpis counted `customer_approved_at` alone as
    // reached with no terminal check, while Insights' computeInsightStats
    // required (approved && !terminal) — same quote, two different "reached"
    // answers. The shared `reached()` helper (also used by
    // computeInsightStats in insights.ts) makes both surfaces agree.
    const k = computeKpis(
      [makeQuote({ quote_sent_at: null, customer_approved_at: '2026-02-01T00:00:00Z', status: 'cancelled' })],
      NOW,
    );
    expect(k.conversionRate).toBeNull(); // 0 reached — nothing to divide
  });
});

describe('reached — shared conversion-denominator rule (WT-48)', () => {
  it('true when sent, regardless of terminal status', () => {
    expect(reached(makeQuote({ quote_sent_at: '2026-01-01T00:00:00Z' }))).toBe(true);
    expect(
      reached(makeQuote({ quote_sent_at: '2026-01-01T00:00:00Z', status: 'cancelled' })),
    ).toBe(true);
  });

  it('true when approved and not terminal, even if never sent (offline close)', () => {
    expect(
      reached(makeQuote({ quote_sent_at: null, customer_approved_at: '2026-01-01T00:00:00Z' })),
    ).toBe(true);
  });

  it('false when approved but terminal and never sent', () => {
    expect(
      reached(
        makeQuote({ quote_sent_at: null, customer_approved_at: '2026-01-01T00:00:00Z', status: 'cancelled' }),
      ),
    ).toBe(false);
  });

  it('false when neither sent nor approved', () => {
    expect(reached(makeQuote())).toBe(false);
  });
});
