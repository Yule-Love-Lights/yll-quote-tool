import { describe, it, expect } from 'vitest';
import { aggregateCustomers, statusOf, customerRouteId, matchesCustomerRoute, expandHlContactIds } from './customers';
import type { DashboardQuote } from './types';

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

describe('statusOf', () => {
  it('maps the lifecycle timestamps to a status', () => {
    expect(statusOf(makeQuote())).toBe('draft');
    expect(statusOf(makeQuote({ quote_sent_at: '2026-06-02T00:00:00Z' }))).toBe('sent');
    expect(
      statusOf(makeQuote({ quote_sent_at: '2026-06-02T00:00:00Z', customer_approved_at: '2026-06-03T00:00:00Z' })),
    ).toBe('approved');
    // approved without ever being marked sent still reads approved
    expect(statusOf(makeQuote({ customer_approved_at: '2026-06-03T00:00:00Z' }))).toBe('approved');
  });

  // BUG-1 (S22): statusOf now delegates to deriveStatus, so a persisted branch/
  // terminal status wins over the timestamps a declined/cancelled quote still
  // carries — previously it read as a stale 'sent'/'approved'.
  it('honors the persisted terminal/branch status over the timestamps', () => {
    // A declined quote still has quote_sent_at — must read 'declined', not 'sent'.
    expect(
      statusOf(makeQuote({ quote_sent_at: '2026-06-02T00:00:00Z', status: 'declined' })),
    ).toBe('declined');
    expect(
      statusOf(makeQuote({ quote_sent_at: '2026-06-02T00:00:00Z', status: 'changes_requested' })),
    ).toBe('changes_requested');
    expect(
      statusOf(makeQuote({ quote_sent_at: '2026-06-02T00:00:00Z', status: 'cancelled' })),
    ).toBe('cancelled');
  });

  it('derives viewed + booked from the extra timestamps', () => {
    expect(statusOf(makeQuote({ quote_sent_at: '2026-06-02T00:00:00Z', viewed_at: '2026-06-02T01:00:00Z' }))).toBe('viewed');
    expect(statusOf(makeQuote({ customer_approved_at: '2026-06-03T00:00:00Z', deposit_paid_at: '2026-06-04T00:00:00Z' }))).toBe('booked');
  });
});

describe('aggregateCustomers — grouping', () => {
  it('returns [] for no quotes', () => {
    expect(aggregateCustomers([])).toEqual([]);
  });

  it('groups quotes that share a highlevel_contact_id into one customer', () => {
    const out = aggregateCustomers([
      makeQuote({ highlevel_contact_id: 'h1', customer_name: 'Ann', customer_email: 'ann@x.com' }),
      makeQuote({ highlevel_contact_id: 'h1', customer_name: 'Ann', customer_email: 'ann2@x.com' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].contactId).toBe('h1');
    expect(out[0].quoteCount).toBe(2);
  });

  it('falls back to email when there is no contact id (same email → one customer)', () => {
    const out = aggregateCustomers([
      makeQuote({ customer_email: 'a@x.com', customer_phone: '555-0001' }),
      makeQuote({ customer_email: 'a@x.com', customer_phone: '555-0002' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].quoteCount).toBe(2);
    expect(out[0].contactId).toBeNull(); // no HL contact id on either
  });

  it('keeps distinct customers separate', () => {
    const out = aggregateCustomers([
      makeQuote({ highlevel_contact_id: 'h1' }),
      makeQuote({ highlevel_contact_id: 'h2' }),
      makeQuote({ customer_email: 'solo@x.com' }),
    ]);
    expect(out).toHaveLength(3);
  });
});

describe('aggregateCustomers — fields', () => {
  it('bookedSpend sums only APPROVED quote totals', () => {
    const out = aggregateCustomers([
      makeQuote({ highlevel_contact_id: 'h1', total: 1500, customer_approved_at: '2026-06-05T00:00:00Z' }),
      makeQuote({ highlevel_contact_id: 'h1', total: 2000, customer_approved_at: null }), // not approved
      makeQuote({ highlevel_contact_id: 'h1', total: 800, customer_approved_at: '2026-06-09T00:00:00Z' }),
    ]);
    expect(out[0].bookedSpend).toBe(2300); // 1500 + 800
    expect(out[0].quoteCount).toBe(3);
  });

  it('treats null totals as 0 in bookedSpend', () => {
    const out = aggregateCustomers([
      makeQuote({ highlevel_contact_id: 'h1', total: null, customer_approved_at: '2026-06-05T00:00:00Z' }),
    ]);
    expect(out[0].bookedSpend).toBe(0);
  });

  it('latestQuoteAt / latestStatus / latestQuoteId come from the most recent quote', () => {
    const out = aggregateCustomers([
      makeQuote({ id: 'old', highlevel_contact_id: 'h1', created_at: '2026-05-01T00:00:00Z', quote_sent_at: '2026-05-02T00:00:00Z', customer_approved_at: '2026-05-03T00:00:00Z' }),
      makeQuote({ id: 'new', highlevel_contact_id: 'h1', created_at: '2026-06-20T00:00:00Z' }), // newest, still a draft
    ]);
    expect(out[0].latestQuoteId).toBe('new');
    expect(out[0].latestQuoteAt).toBe('2026-06-20T00:00:00Z');
    expect(out[0].latestStatus).toBe('draft');
  });

  it('uses a contact name fallback when the latest quote name is blank', () => {
    const out = aggregateCustomers([
      makeQuote({ highlevel_contact_id: 'h1', customer_name: null, created_at: '2026-06-20T00:00:00Z' }),
      makeQuote({ highlevel_contact_id: 'h1', customer_name: 'Bob Smith', created_at: '2026-05-01T00:00:00Z' }),
    ]);
    // latest quote has no name → fall back to a known name from the group
    expect(out[0].name).toBe('Bob Smith');
  });
});

describe('aggregateCustomers — sort', () => {
  it('sorts most-recent customer first', () => {
    const out = aggregateCustomers([
      makeQuote({ id: 'a', highlevel_contact_id: 'h1', created_at: '2026-05-01T00:00:00Z' }),
      makeQuote({ id: 'b', highlevel_contact_id: 'h2', created_at: '2026-06-20T00:00:00Z' }),
    ]);
    expect(out.map(c => c.contactId)).toEqual(['h2', 'h1']);
  });
});

describe('aggregateCustomers — customerId (S22 profile-link fix)', () => {
  it('surfaces the stable customer_id from any quote in the group', () => {
    const out = aggregateCustomers([
      makeQuote({ customer_email: 'a@x.com', customer_id: null, created_at: '2026-06-20T00:00:00Z' }),
      makeQuote({ customer_email: 'a@x.com', customer_id: 'cust-1', created_at: '2026-05-01T00:00:00Z' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].customerId).toBe('cust-1');
  });

  it('customerId is null when no quote carries one (pre-backfill legacy)', () => {
    const out = aggregateCustomers([makeQuote({ customer_email: 'a@x.com' })]);
    expect(out[0].customerId).toBeNull();
  });
});

describe('customerRouteId', () => {
  const base = { key: 'k', name: 'N', email: null, phone: null, quoteCount: 1, bookedSpend: 0, latestQuoteAt: '2026-06-01T00:00:00Z', latestStatus: 'draft' as const, latestQuoteId: 'q1' };

  it('prefers the HighLevel contact id when present', () => {
    expect(customerRouteId({ ...base, contactId: 'h1', customerId: 'cust-1' })).toBe('h1');
  });

  it('falls back to the stable customer_id when there is no HL contact', () => {
    expect(customerRouteId({ ...base, contactId: null, customerId: 'cust-1' })).toBe('cust-1');
  });

  it('is null for an identity-less walk-in (neither id)', () => {
    expect(customerRouteId({ ...base, contactId: null, customerId: null })).toBeNull();
  });
});

describe('matchesCustomerRoute', () => {
  it('matches a quote by its HighLevel contact id', () => {
    expect(matchesCustomerRoute(makeQuote({ highlevel_contact_id: 'h1' }), 'h1')).toBe(true);
  });

  it('matches a quote by its stable customer_id', () => {
    expect(matchesCustomerRoute(makeQuote({ customer_id: 'cust-1' }), 'cust-1')).toBe(true);
  });

  it('does not match an unrelated quote', () => {
    expect(matchesCustomerRoute(makeQuote({ highlevel_contact_id: 'h1', customer_id: 'cust-1' }), 'other')).toBe(false);
  });
});

describe('expandHlContactIds', () => {
  it('expands past the routeId-matched quotes to a second HL id sharing the same customer_id', () => {
    // The exact merge/re-match shape this exists for: two quotes share one
    // customer_id but carry DIFFERENT HighLevel contact ids (the customer's
    // record was re-matched in HighLevel at some point). Visiting the profile
    // via the OLD id must still surface the NEW id's calls, not just its own.
    const older = makeQuote({ customer_id: 'cust-1', highlevel_contact_id: 'hl-old' });
    const newer = makeQuote({ customer_id: 'cust-1', highlevel_contact_id: 'hl-new' });
    const allQuotes = [older, newer];
    const matchedQuotes = allQuotes.filter(q => matchesCustomerRoute(q, 'hl-old'));

    expect(matchedQuotes.map(q => q.highlevel_contact_id)).toEqual(['hl-old']); // the bug's precondition
    expect(expandHlContactIds(allQuotes, matchedQuotes).sort()).toEqual(['hl-new', 'hl-old']);
  });

  it('falls back to the matched quotes alone when none carry a customer_id', () => {
    const q = makeQuote({ customer_id: null, highlevel_contact_id: 'hl-1' });
    expect(expandHlContactIds([q], [q])).toEqual(['hl-1']);
  });

  it('does not pull in an unrelated customer sharing no customer_id', () => {
    const mine = makeQuote({ customer_id: 'cust-1', highlevel_contact_id: 'hl-1' });
    const other = makeQuote({ customer_id: 'cust-2', highlevel_contact_id: 'hl-2' });
    expect(expandHlContactIds([mine, other], [mine])).toEqual(['hl-1']);
  });
});
