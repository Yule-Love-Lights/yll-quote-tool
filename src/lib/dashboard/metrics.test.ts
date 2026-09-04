import { describe, it, expect } from 'vitest';
import { computeKpis, reached, customerKey, isNeighbor, settled } from './metrics';
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

  it('declined and abandoned orders also do NOT count as booked revenue', () => {
    const k = computeKpis(
      [
        makeQuote({ total: 3000, customer_approved_at: '2026-06-01T00:00:00Z', status: 'declined' }),
        makeQuote({ total: 4000, customer_approved_at: '2026-06-01T00:00:00Z', status: 'abandoned' }),
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

// ---------------------------------------------------------------------------
// Backlog sends (2026-09-03) — a quote built weeks ago and held, then sent as
// part of a season-open wave. The created→sent gap is a scheduling decision,
// not a response time, so it is left out of the turnaround average and nothing
// else. See migrations/2026-09-03-quote-backlog-send.sql.
// ---------------------------------------------------------------------------
describe('computeKpis — backlog sends and the turnaround average', () => {
  const ONE_DAY_SEND = {
    created_at: '2026-06-20T12:00:00Z',
    quote_sent_at: '2026-06-21T12:00:00Z',
  };
  const FORTY_DAY_SEND = {
    created_at: '2026-05-12T12:00:00Z',
    quote_sent_at: '2026-06-21T12:00:00Z',
  };

  it('leaves a backlog-marked send out of the turnaround average', () => {
    const kpis = computeKpis(
      [
        makeQuote(ONE_DAY_SEND),
        makeQuote({ ...FORTY_DAY_SEND, backlog_send_at: '2026-06-21T12:00:00Z' }),
      ],
      NOW,
    );
    // Without the exclusion this averages to 20.5 days.
    expect(kpis.avgTurnaroundDays).toBe(1);
  });

  it('reports how many sends it excluded, so the card can say so', () => {
    const kpis = computeKpis(
      [
        makeQuote(ONE_DAY_SEND),
        makeQuote({ ...FORTY_DAY_SEND, backlog_send_at: '2026-06-21T12:00:00Z' }),
        makeQuote({ ...FORTY_DAY_SEND, backlog_send_at: '2026-06-21T12:00:00Z' }),
      ],
      NOW,
    );
    expect(kpis.turnaroundExcluded).toBe(2);
  });

  it('reports zero excluded when nothing is marked', () => {
    expect(computeKpis([makeQuote(ONE_DAY_SEND)], NOW).turnaroundExcluded).toBe(0);
  });

  it('returns a null turnaround, not zero, when every send is backlog-marked', () => {
    const kpis = computeKpis(
      [makeQuote({ ...FORTY_DAY_SEND, backlog_send_at: '2026-06-21T12:00:00Z' })],
      NOW,
    );
    expect(kpis.avgTurnaroundDays).toBeNull();
    expect(kpis.turnaroundExcluded).toBe(1);
  });

  // The exclusion is scoped to turnaround. A backlog send is a real quote to a
  // real customer: it still counts as reached, as booked revenue when approved,
  // and as an active quote while it waits.
  it('still counts a backlog send in conversion, revenue and active quotes', () => {
    // 10 days old: past the conversion cooling window, still inside the
    // 60-day active-quote window, so this test measures the backlog
    // exclusion rather than either window's edge.
    const recentSend = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    const kpis = computeKpis(
      [
        makeQuote({
          created_at: '2026-05-12T12:00:00Z',
          quote_sent_at: recentSend,
          backlog_send_at: recentSend,
          total: 5000,
        }),
        makeQuote({
          created_at: '2026-05-12T12:00:00Z',
          quote_sent_at: recentSend,
          backlog_send_at: recentSend,
          customer_approved_at: recentSend,
          total: 4000,
        }),
      ],
      NOW,
    );
    expect(kpis.bookedRevenue).toBe(4000);
    expect(kpis.activeQuotes).toBe(1);
    expect(kpis.conversionRate).toBe(0.5);
    expect(kpis.avgTurnaroundDays).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Neighbor split (2026-09-03) — Naldo's rule: either flag counts. The customer
// tag (customers.is_yll_neighbor, #198) follows the person; legacy_rebook
// (#155/#181) is frozen on the quote from last season's migration. Many older
// neighbors carry only the second one.
// ---------------------------------------------------------------------------
describe('isNeighbor — either flag counts', () => {
  it('counts the customer tag on its own', () => {
    expect(isNeighbor(makeQuote({ is_yll_neighbor: true, legacy_rebook: false }))).toBe(true);
  });

  it('counts the quote flag on its own', () => {
    expect(isNeighbor(makeQuote({ is_yll_neighbor: false, legacy_rebook: true }))).toBe(true);
  });

  it('counts a quote carrying both once', () => {
    expect(isNeighbor(makeQuote({ is_yll_neighbor: true, legacy_rebook: true }))).toBe(true);
  });

  it('is regular when neither flag is set', () => {
    expect(isNeighbor(makeQuote({ is_yll_neighbor: false, legacy_rebook: false }))).toBe(false);
  });

  // A quote with no customer row selected leaves is_yll_neighbor undefined
  // rather than false. Undefined must read as "not a neighbor", never crash.
  it('treats missing flags as regular', () => {
    expect(isNeighbor(makeQuote())).toBe(false);
  });
});

describe('computeKpis — conversion split by neighbor', () => {
  // Comfortably outside the cooling window (NOW is 2026-06-24), so these
  // tests measure the SPLIT and not the window. The window has its own tests.
  const SENT = '2026-06-01T12:00:00Z';
  const APPROVED = '2026-06-03T12:00:00Z';

  function population(): DashboardQuote[] {
    return [
      // 2 neighbors reached, 1 approved
      makeQuote({ quote_sent_at: SENT, legacy_rebook: true, customer_approved_at: APPROVED }),
      makeQuote({ quote_sent_at: SENT, is_yll_neighbor: true }),
      // 3 regular reached, 2 approved
      makeQuote({ quote_sent_at: SENT, customer_approved_at: APPROVED }),
      makeQuote({ quote_sent_at: SENT, customer_approved_at: APPROVED }),
      makeQuote({ quote_sent_at: SENT }),
      // never reached — belongs to neither split
      makeQuote(),
    ];
  }

  it('splits conversion into neighbor and regular, with counts', () => {
    const kpis = computeKpis(population(), NOW);
    expect(kpis.conversionNeighbor).toEqual({ reached: 2, approved: 1, rate: 0.5 });
    expect(kpis.conversionRegular).toEqual({ reached: 3, approved: 2, rate: 2 / 3 });
  });

  it('keeps the overall rate exactly as it was', () => {
    const kpis = computeKpis(population(), NOW);
    expect(kpis.conversionRate).toBe(3 / 5);
  });

  it('reconciles: the two splits sum to the overall numerator and denominator', () => {
    const kpis = computeKpis(population(), NOW);
    const reachedSum = kpis.conversionNeighbor.reached + kpis.conversionRegular.reached;
    const approvedSum = kpis.conversionNeighbor.approved + kpis.conversionRegular.approved;
    expect(approvedSum / reachedSum).toBe(kpis.conversionRate);
  });

  it('gives a null rate, not zero, for a split nobody has reached', () => {
    const kpis = computeKpis([makeQuote({ quote_sent_at: SENT })], NOW);
    expect(kpis.conversionNeighbor).toEqual({ reached: 0, approved: 0, rate: null });
    expect(kpis.conversionRegular.rate).toBe(0);
  });

  // A quote approved then cancelled is not a conversion on either side of the
  // split, exactly as it is not one overall (the B7 terminal-status rule).
  it('does not count a terminal quote as an approval in its split', () => {
    const kpis = computeKpis(
      [
        makeQuote({
          quote_sent_at: SENT,
          customer_approved_at: APPROVED,
          status: 'cancelled',
          legacy_rebook: true,
        }),
      ],
      NOW,
    );
    expect(kpis.conversionNeighbor).toEqual({ reached: 1, approved: 0, rate: 0 });
  });
});

// ---------------------------------------------------------------------------
// The conversion cooling window (2026-09-04). A quote sent yesterday has no
// outcome yet. Counting it as a loss made a 51-quote send wave read as
// "Neighbors convert at 27%" when the settled figure was 71%.
// ---------------------------------------------------------------------------
describe('settled — has this quote had time to be answered?', () => {
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

  it('is false for a quote sent inside the window', () => {
    expect(settled(makeQuote({ quote_sent_at: days(1) }), NOW)).toBe(false);
  });

  it('is true once the quote is older than the window', () => {
    expect(settled(makeQuote({ quote_sent_at: days(8) }), NOW)).toBe(true);
  });

  it('treats the window edge as settled', () => {
    expect(settled(makeQuote({ quote_sent_at: days(DASHBOARD_CONFIG.conversionCoolingDays) }), NOW)).toBe(true);
  });

  // An offline close was decided before it was ever recorded, so it has
  // nothing to wait for.
  it('counts an approved quote with no send date immediately', () => {
    expect(settled(makeQuote({ quote_sent_at: null, customer_approved_at: days(0) }), NOW)).toBe(true);
  });
});

describe('computeKpis — the cooling window applies to every conversion number alike', () => {
  const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

  function wave(): DashboardQuote[] {
    return [
      // settled: 1 neighbor won, 1 neighbor lost, 1 regular won
      makeQuote({ quote_sent_at: days(30), customer_approved_at: days(28), legacy_rebook: true }),
      makeQuote({ quote_sent_at: days(30), legacy_rebook: true }),
      makeQuote({ quote_sent_at: days(30), customer_approved_at: days(28) }),
      // a wave sent yesterday, all neighbors, none answered yet
      makeQuote({ quote_sent_at: days(1), legacy_rebook: true }),
      makeQuote({ quote_sent_at: days(1), legacy_rebook: true }),
      makeQuote({ quote_sent_at: days(1), legacy_rebook: true }),
    ];
  }

  it('keeps a fresh send out of every rate rather than counting it as a loss', () => {
    const k = computeKpis(wave(), NOW);
    // Without the window the neighbor rate would be 1/5 = 20%.
    expect(k.conversionNeighbor).toEqual({ reached: 2, approved: 1, rate: 0.5 });
    expect(k.conversionRegular).toEqual({ reached: 1, approved: 1, rate: 1 });
    expect(k.conversionRate).toBe(2 / 3);
  });

  it('counts the fresh sends separately so nothing disappears quietly', () => {
    expect(computeKpis(wave(), NOW).conversionPendingRecent).toBe(3);
  });

  it('reports no pending when every quote has had its time', () => {
    const k = computeKpis([makeQuote({ quote_sent_at: days(30) })], NOW);
    expect(k.conversionPendingRecent).toBe(0);
  });

  // The cohort counts what happened, win or lose. Ignoring recent losses while
  // keeping recent wins would quietly flatter the rate.
  it('does NOT count a win that is still inside the window', () => {
    const k = computeKpis(
      [
        makeQuote({ quote_sent_at: days(30) }),
        makeQuote({ quote_sent_at: days(1), customer_approved_at: days(0) }),
      ],
      NOW,
    );
    expect(k.conversionRate).toBe(0);
    expect(k.conversionPendingRecent).toBe(1);
  });

  // Money is not a rate. A deposit taken yesterday is real revenue today.
  it('still books revenue for an approval inside the window', () => {
    const k = computeKpis(
      [makeQuote({ quote_sent_at: days(1), customer_approved_at: days(0), total: 4200 })],
      NOW,
    );
    expect(k.bookedRevenue).toBe(4200);
    expect(k.conversionRate).toBeNull();
  });

  // A quote cancelled two days after it was sent is decided, but it waits for
  // its own cohort exactly as a recent WIN does. Counting the loss now while
  // holding the win back would tilt the rate downwards.
  it('holds a loss inside the window back too, not just a win', () => {
    const k = computeKpis(
      [
        makeQuote({ quote_sent_at: days(30), customer_approved_at: days(28) }),
        makeQuote({ quote_sent_at: days(2), status: 'declined' }),
      ],
      NOW,
    );
    expect(k.conversionRate).toBe(1);
    expect(k.conversionPendingRecent).toBe(1);
  });

  it('applies the window to neighbors and regular by the same rule', () => {
    const k = computeKpis(
      [
        makeQuote({ quote_sent_at: days(1), legacy_rebook: true }),
        makeQuote({ quote_sent_at: days(1) }),
      ],
      NOW,
    );
    expect(k.conversionNeighbor.reached).toBe(0);
    expect(k.conversionRegular.reached).toBe(0);
    expect(k.conversionPendingRecent).toBe(2);
  });
});
