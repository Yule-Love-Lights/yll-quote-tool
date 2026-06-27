import { describe, it, expect } from 'vitest';
import { aggregateCustomers, statusOf } from './customers';
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
