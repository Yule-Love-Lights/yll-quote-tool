// Tests for the header search box's engine (src/lib/search/globalSearch.ts).

import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  customerHref,
  displayNumberToken,
  emptyResults,
  flattenResults,
  globalSearch,
  humanStatus,
  nextIndex,
  isActiveInvoice,
  isActiveJob,
  isActiveQuote,
  phoneDigits,
  safeOrValue,
  sortHits,
  totalCount,
  type SearchHit,
} from './globalSearch';

describe('displayNumberToken', () => {
  it('reads a bare number and a hash-prefixed one', () => {
    expect(displayNumberToken('1262')).toBe(1262);
    expect(displayNumberToken('#1262')).toBe(1262);
    expect(displayNumberToken('  1000 ')).toBe(1000);
  });

  it('is not fooled by a phone number', () => {
    // The whole point of anchoring the pattern: a dashed phone number must not
    // become a quote-number lookup.
    expect(displayNumberToken('516-555-0123')).toBeNull();
    expect(displayNumberToken('(516) 555-0123')).toBeNull();
  });

  it('rejects text, zero, and negatives', () => {
    expect(displayNumberToken('Kristie')).toBeNull();
    expect(displayNumberToken('12a')).toBeNull();
    expect(displayNumberToken('0')).toBeNull();
    expect(displayNumberToken('-5')).toBeNull();
  });
});

describe('phoneDigits', () => {
  it('strips a formatted phone number down to its digits', () => {
    expect(phoneDigits('(516) 555-0123')).toBe('5165550123');
    expect(phoneDigits('516.555.0123')).toBe('5165550123');
  });

  it('returns null when there are too few digits to be a phone number', () => {
    expect(phoneDigits('Smith')).toBeNull();
    expect(phoneDigits('12345')).toBeNull();
  });

  it('returns digits only, so the value is always safe for an or() filter', () => {
    const out = phoneDigits('(516) 555-0123,name.ilike.*');
    expect(out).not.toBeNull();
    expect(safeOrValue(out!)).toBe(true);
    expect(/^\d+$/.test(out!)).toBe(true);
  });
});

describe('safeOrValue', () => {
  it('rejects the characters that would rewrite a PostgREST filter', () => {
    expect(safeOrValue('Kristie')).toBe(true);
    expect(safeOrValue('a,b')).toBe(false);
    expect(safeOrValue('a(b')).toBe(false);
    expect(safeOrValue('a)b')).toBe(false);
  });
});

describe('humanStatus', () => {
  it('humanises the underscored lifecycle values', () => {
    expect(humanStatus('requires_invoicing')).toBe('Requires invoicing');
    expect(humanStatus('awaiting_payment')).toBe('Awaiting payment');
    expect(humanStatus('paid')).toBe('Paid');
    expect(humanStatus(null)).toBeNull();
  });
});

describe('active predicates', () => {
  it('treats only the closed lifecycle states as inactive', () => {
    expect(isActiveQuote('sent')).toBe(true);
    expect(isActiveQuote('booked')).toBe(true);
    expect(isActiveQuote('declined')).toBe(false);
    expect(isActiveQuote('cancelled')).toBe(false);
    expect(isActiveQuote('abandoned')).toBe(false);

    expect(isActiveJob('scheduled')).toBe(true);
    expect(isActiveJob('done')).toBe(false);
    expect(isActiveJob('cancelled')).toBe(false);

    expect(isActiveInvoice('awaiting_payment')).toBe(true);
    expect(isActiveInvoice('draft')).toBe(true);
    expect(isActiveInvoice('paid')).toBe(false);
    expect(isActiveInvoice('cancelled')).toBe(false);
  });

  it('reads a missing status as active rather than hiding the row', () => {
    expect(isActiveQuote(null)).toBe(true);
    expect(isActiveJob(null)).toBe(true);
    expect(isActiveInvoice(null)).toBe(true);
  });
});

describe('customerHref', () => {
  it('prefers the HighLevel contact id, like every other customer link', () => {
    expect(customerHref({ id: 'uuid-1', hl_contact_id: 'hl-9' })).toBe('/customers/hl-9');
  });

  it('falls back to our own customer id', () => {
    expect(customerHref({ id: 'uuid-1', hl_contact_id: null })).toBe('/customers/uuid-1');
  });

  it('encodes an id that would otherwise break the path', () => {
    expect(customerHref({ id: 'a/b?c', hl_contact_id: null })).toBe('/customers/a%2Fb%3Fc');
  });
});

function hit(over: Partial<SearchHit>): SearchHit {
  return {
    kind: 'quote',
    key: 'k',
    href: '/x',
    title: 't',
    subtitle: null,
    label: null,
    status: null,
    active: true,
    sortedAt: null,
    ...over,
  };
}

describe('sortHits', () => {
  it('puts active records first and keeps the closed ones findable below', () => {
    const out = sortHits([
      hit({ key: 'old-paid', active: false, sortedAt: '2026-08-30T00:00:00Z' }),
      hit({ key: 'open', active: true, sortedAt: '2026-01-01T00:00:00Z' }),
    ]);
    expect(out.map((h) => h.key)).toEqual(['open', 'old-paid']);
    // Findable, not merely deprioritised.
    expect(out).toHaveLength(2);
  });

  it('orders newest first inside a tier', () => {
    const out = sortHits([
      hit({ key: 'older', active: true, sortedAt: '2026-01-01T00:00:00Z' }),
      hit({ key: 'newer', active: true, sortedAt: '2026-08-01T00:00:00Z' }),
    ]);
    expect(out.map((h) => h.key)).toEqual(['newer', 'older']);
  });

  it('does not mutate its input', () => {
    const input = [hit({ key: 'a', active: false }), hit({ key: 'b', active: true })];
    sortHits(input);
    expect(input.map((h) => h.key)).toEqual(['a', 'b']);
  });
});

// --- globalSearch --------------------------------------------------------

type Call = { table: string; op: string; arg?: string };

/**
 * A supabase-js stand-in. Each table maps to a QUEUE of responses, consumed in
 * call order, because `quotes` is read twice in one search (the text match,
 * then the name lookup for number-matched jobs and invoices).
 */
function makeSb(queues: Record<string, unknown[][]>, calls: Call[]): SupabaseClient {
  const next = (table: string): unknown[] => {
    const q = queues[table];
    if (!q || q.length === 0) return [];
    return q.shift() ?? [];
  };

  const make = (table: string) => {
    const finish = () => Promise.resolve({ data: next(table), error: null });
    const builder: Record<string, unknown> = {};
    Object.assign(builder, {
      select: (cols: string) => {
        calls.push({ table, op: 'select', arg: cols });
        return builder;
      },
      eq: (col: string, val: unknown) => {
        calls.push({ table, op: 'eq', arg: `${col}=${String(val)}` });
        return builder;
      },
      or: (filter: string) => {
        calls.push({ table, op: 'or', arg: filter });
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        calls.push({ table, op: 'in', arg: `${col}:${vals.join('|')}` });
        return finish();
      },
      order: () => builder,
      limit: () => finish(),
    });
    return builder;
  };

  return {
    from: (table: string) => {
      calls.push({ table, op: 'from' });
      return make(table);
    },
  } as unknown as SupabaseClient;
}

const QUOTE_ROW = {
  id: 'q1',
  quote_number: 1262,
  customer_name: 'Kristie Tibbetts',
  customer_address: '12 Maple St, Glen Cove NY',
  status: 'sent',
  total: 4200,
  created_at: '2026-08-01T00:00:00Z',
};

describe('globalSearch', () => {
  it('returns nothing and touches the database not at all for a one-character query', async () => {
    const calls: Call[] = [];
    const out = await globalSearch(makeSb({}, calls), 'K');
    expect(out).toEqual(emptyResults());
    expect(calls).toHaveLength(0);
  });

  it('refuses a query carrying filter punctuation instead of passing it through', async () => {
    const calls: Call[] = [];
    const out = await globalSearch(makeSb({}, calls), 'a,name.ilike.*');
    expect(totalCount(out)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('finds a customer, their quote, and the job and invoice hanging off it', async () => {
    const calls: Call[] = [];
    const sb = makeSb(
      {
        customers: [
          [
            {
              id: 'c1',
              name: 'Kristie Tibbetts',
              email: 'k@example.com',
              phone: '5165550123',
              hl_contact_id: 'hl-9',
              updated_at: '2026-08-02T00:00:00Z',
            },
          ],
        ],
        quotes: [[QUOTE_ROW]],
        jobs: [
          [
            {
              id: 'j1',
              job_number: 1000,
              quote_id: 'q1',
              status: 'scheduled',
              install_date: '2026-11-14',
              created_at: '2026-08-03T00:00:00Z',
            },
          ],
        ],
        invoices: [
          [
            {
              id: 'i1',
              invoice_number: 1000,
              quote_id: 'q1',
              status: 'awaiting_payment',
              balance: 2100,
              total: 4200,
              created_at: '2026-08-04T00:00:00Z',
            },
          ],
        ],
      },
      calls,
    );

    const out = await globalSearch(sb, 'Kristie');

    expect(out.customers[0].href).toBe('/customers/hl-9');
    expect(out.quotes[0]).toMatchObject({
      href: '/admin/quotes/q1',
      label: '#1262',
      status: 'Sent',
      active: true,
    });
    expect(out.quotes[0].subtitle).toContain('12 Maple St');
    expect(out.jobs[0]).toMatchObject({ href: '/admin/jobs/j1', label: '#1000', title: 'Kristie Tibbetts' });
    expect(out.invoices[0]).toMatchObject({ href: '/admin/invoices/i1', status: 'Awaiting payment' });
    expect(out.invoices[0].subtitle).toContain('due');

    // The jobs and invoices reads are scoped to the quotes that actually
    // matched, never to the whole table.
    const jobOr = calls.find((c) => c.table === 'jobs' && c.op === 'or');
    expect(jobOr?.arg).toContain('quote_id.in.(q1)');
  });

  it('excludes test quotes', async () => {
    const calls: Call[] = [];
    await globalSearch(makeSb({ quotes: [[]] }, calls), 'Kristie');
    expect(calls).toContainEqual({ table: 'quotes', op: 'eq', arg: 'is_test=false' });
  });

  it('looks a record up by its display number and still names the customer', async () => {
    const calls: Call[] = [];
    const sb = makeSb(
      {
        customers: [[]],
        // The text search misses (nobody is called "1000"), so the job below is
        // found by its own number and its customer name comes from the second
        // quotes read.
        quotes: [[], [{ id: 'q9', customer_name: 'Raymond Diaz' }]],
        jobs: [
          [
            {
              id: 'j9',
              job_number: 1000,
              quote_id: 'q9',
              status: 'done',
              install_date: null,
              created_at: '2026-02-01T00:00:00Z',
            },
          ],
        ],
        invoices: [[]],
      },
      calls,
    );

    const out = await globalSearch(sb, '#1000');

    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0].title).toBe('Raymond Diaz');
    expect(out.jobs[0].active).toBe(false);
    expect(calls).toContainEqual({ table: 'quotes', op: 'in', arg: 'id:q9' });
    const jobOr = calls.find((c) => c.table === 'jobs' && c.op === 'or');
    expect(jobOr?.arg).toBe('job_number.eq.1000');
  });

  it('does not read jobs or invoices at all when nothing can match them', async () => {
    const calls: Call[] = [];
    // A text query that matched no quotes: there is no quote id list to scope
    // by, and an empty in() list would be a no-op filter returning everything.
    await globalSearch(makeSb({ customers: [[]], quotes: [[]] }, calls), 'Zzzz');
    expect(calls.some((c) => c.table === 'jobs')).toBe(false);
    expect(calls.some((c) => c.table === 'invoices')).toBe(false);
  });

  it('searches the phone digits as well as the raw text', async () => {
    const calls: Call[] = [];
    await globalSearch(makeSb({ customers: [[]], quotes: [[]] }, calls), '516 555 0123');
    const customerOr = calls.find((c) => c.table === 'customers' && c.op === 'or');
    expect(customerOr?.arg).toContain('phone.ilike.%5165550123%');
    expect(customerOr?.arg).toContain('name.ilike.%516 555 0123%');
  });

  it('still finds a phone number typed with parentheses, on the digits alone', async () => {
    // "(516) 555-0123" is how a person actually types a phone number, and the
    // parentheses make the raw text unsafe for an or() filter. The digits
    // branch is the only path this query has, so dropping it would make the
    // most natural phone search silently return nothing.
    const calls: Call[] = [];
    await globalSearch(makeSb({ customers: [[]], quotes: [[]] }, calls), '(516) 555-0123');
    const customerOr = calls.find((c) => c.table === 'customers' && c.op === 'or');
    expect(customerOr?.arg).toBe('phone.ilike.%5165550123%');
    // The punctuated text itself never reaches the filter.
    expect(customerOr?.arg).not.toContain('(');
  });

  it('keeps a paid invoice findable but ranks it below an unpaid one', async () => {
    const calls: Call[] = [];
    const sb = makeSb(
      {
        customers: [[]],
        quotes: [[QUOTE_ROW]],
        jobs: [[]],
        invoices: [
          [
            {
              id: 'paid',
              invoice_number: 1001,
              quote_id: 'q1',
              status: 'paid',
              balance: 0,
              total: 4200,
              created_at: '2026-08-20T00:00:00Z',
            },
            {
              id: 'open',
              invoice_number: 1002,
              quote_id: 'q1',
              status: 'awaiting_payment',
              balance: 500,
              total: 500,
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
        ],
      },
      calls,
    );

    const out = await globalSearch(sb, 'Kristie');
    expect(out.invoices.map((h) => h.key)).toEqual(['invoice:open', 'invoice:paid']);
    // A settled invoice shows what it was worth, not a zero balance "due".
    expect(out.invoices[1].subtitle).toBe('$4,200.00');
  });

  it('walks the arrow keys through the hits and wraps at both ends', () => {
    expect(nextIndex(-1, 1, 3)).toBe(0); // Down from nothing highlighted
    expect(nextIndex(-1, -1, 3)).toBe(2); // Up from nothing highlighted
    expect(nextIndex(0, 1, 3)).toBe(1);
    expect(nextIndex(2, 1, 3)).toBe(0); // wraps forward
    expect(nextIndex(0, -1, 3)).toBe(2); // wraps back
  });

  it('highlights nothing when there are no hits', () => {
    expect(nextIndex(-1, 1, 0)).toBe(-1);
    expect(nextIndex(0, 1, 0)).toBe(-1);
  });

  it('flattens the four groups in the order the keyboard walks them', () => {
    const results = {
      customers: [hit({ key: 'c' })],
      quotes: [hit({ key: 'q' })],
      jobs: [hit({ key: 'j' })],
      invoices: [hit({ key: 'i' })],
    };
    expect(flattenResults(results).map((h) => h.key)).toEqual(['c', 'q', 'j', 'i']);
    expect(totalCount(results)).toBe(4);
  });
});
