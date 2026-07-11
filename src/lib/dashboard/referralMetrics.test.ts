import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeReferralMetrics, loadReferralMetrics, type ReferralMetricsRow } from './referralMetrics';

function row(over: Partial<ReferralMetricsRow> = {}): ReferralMetricsRow {
  return {
    id: crypto.randomUUID(),
    referrer_customer_id: 'c1',
    referee_quote_id: null,
    status: 'pending',
    ...over,
  };
}

describe('computeReferralMetrics — empty state', () => {
  it('returns zeros/nulls for no rows at all', () => {
    const out = computeReferralMetrics([], new Map(), new Map());
    expect(out).toEqual({
      totalReferrals: 0,
      bookedConversionRate: null,
      revenueInfluenced: { kind: 'count', count: 0 },
      topReferrers: [],
    });
  });
});

describe('computeReferralMetrics — conversion math', () => {
  it('computes (booked + credited) / total', () => {
    const rows = [
      row({ status: 'pending' }),
      row({ status: 'booked' }),
      row({ status: 'credited' }),
      row({ status: 'pending' }),
    ];
    const out = computeReferralMetrics(rows, new Map(), new Map());
    expect(out.totalReferrals).toBe(4);
    expect(out.bookedConversionRate).toBe(0.5);
  });

  it('is null-free when 0/4 have converted (not NaN)', () => {
    const rows = [row({ status: 'pending' }), row({ status: 'pending' })];
    const out = computeReferralMetrics(rows, new Map(), new Map());
    expect(out.bookedConversionRate).toBe(0);
  });

  it('is 100% when every referral converted', () => {
    const rows = [row({ status: 'booked' }), row({ status: 'credited' })];
    const out = computeReferralMetrics(rows, new Map(), new Map());
    expect(out.bookedConversionRate).toBe(1);
  });
});

describe('computeReferralMetrics — revenue influenced', () => {
  it('sums the linked quotes\' totals for booked/credited referrals', () => {
    const rows = [
      row({ status: 'booked', referee_quote_id: 'q1' }),
      row({ status: 'credited', referee_quote_id: 'q2' }),
      row({ status: 'pending', referee_quote_id: 'q3' }), // not converted — excluded
    ];
    const quoteTotalsById = new Map([
      ['q1', 2500],
      ['q2', 1800],
      ['q3', 9999], // pending — must NOT be counted
    ]);
    const out = computeReferralMetrics(rows, quoteTotalsById, new Map());
    expect(out.revenueInfluenced).toEqual({ kind: 'usd', amountUsd: 4300 });
  });

  it('falls back to a plain count when none of the linked quotes resolve', () => {
    const rows = [row({ status: 'booked', referee_quote_id: 'q1' }), row({ status: 'credited', referee_quote_id: 'q2' })];
    const out = computeReferralMetrics(rows, new Map(), new Map()); // empty totals map — nothing resolves
    expect(out.revenueInfluenced).toEqual({ kind: 'count', count: 2 });
  });

  it('falls back to count:0 when there are referrals but none have converted yet', () => {
    const rows = [row({ status: 'pending' }), row({ status: 'pending' })];
    const out = computeReferralMetrics(rows, new Map(), new Map());
    expect(out.revenueInfluenced).toEqual({ kind: 'count', count: 0 });
  });

  it('only sums totals that actually resolve, skipping the rest', () => {
    const rows = [
      row({ status: 'booked', referee_quote_id: 'q1' }),
      row({ status: 'booked', referee_quote_id: 'q-missing' }), // no entry in the map
    ];
    const quoteTotalsById = new Map([['q1', 1000]]);
    const out = computeReferralMetrics(rows, quoteTotalsById, new Map());
    expect(out.revenueInfluenced).toEqual({ kind: 'usd', amountUsd: 1000 });
  });
});

describe('computeReferralMetrics — top referrers', () => {
  it('ranks referrers by converted count, descending, top 3', () => {
    const rows = [
      row({ referrer_customer_id: 'a', status: 'booked' }),
      row({ referrer_customer_id: 'a', status: 'booked' }),
      row({ referrer_customer_id: 'a', status: 'credited' }),
      row({ referrer_customer_id: 'b', status: 'booked' }),
      row({ referrer_customer_id: 'c', status: 'booked' }),
      row({ referrer_customer_id: 'd', status: 'booked' }),
      row({ referrer_customer_id: 'e', status: 'pending' }), // not converted — excluded entirely
    ];
    const namesById = new Map([
      ['a', 'Jordan Smith'],
      ['b', 'Alex Chen'],
      ['c', 'Riley Park'],
      ['d', 'Sam Rivera'],
    ]);
    const out = computeReferralMetrics(rows, new Map(), namesById);
    expect(out.topReferrers).toHaveLength(3);
    expect(out.topReferrers[0]).toEqual({ customerId: 'a', name: 'Jordan Smith', convertedCount: 3 });
    // b/c/d tie at 1 — broken by customer id ascending.
    expect(out.topReferrers[1].customerId).toBe('b');
    expect(out.topReferrers[2].customerId).toBe('c');
  });

  it('excludes pending-only referrers from the ranking entirely', () => {
    const rows = [row({ referrer_customer_id: 'a', status: 'pending' })];
    const out = computeReferralMetrics(rows, new Map(), new Map([['a', 'Jordan Smith']]));
    expect(out.topReferrers).toEqual([]);
  });

  it('falls back to a placeholder name when the customer lookup missed', () => {
    const rows = [row({ referrer_customer_id: 'a', status: 'booked' })];
    const out = computeReferralMetrics(rows, new Map(), new Map());
    expect(out.topReferrers[0]).toEqual({ customerId: 'a', name: 'Unknown customer', convertedCount: 1 });
  });

  it('never counts a null referrer_customer_id as a rankable referrer', () => {
    const rows = [row({ referrer_customer_id: null, status: 'booked' })];
    const out = computeReferralMetrics(rows, new Map(), new Map());
    expect(out.topReferrers).toEqual([]);
  });
});

// ─── loadReferralMetrics: batched I/O + is_test isolation ──────────────────

function makeSupabaseStub(tables: {
  referrals: unknown[];
  quotes?: Array<{ id: string; total: number | null; is_test: boolean | null }>;
  customers?: Array<{ id: string; name: string | null }>;
}) {
  return {
    from(table: string) {
      if (table === 'referrals') {
        return { select: () => Promise.resolve({ data: tables.referrals, error: null }) };
      }
      if (table === 'quotes') {
        return {
          select: () => ({
            in: (_col: string, ids: string[]) =>
              Promise.resolve({ data: (tables.quotes ?? []).filter((q) => ids.includes(q.id)), error: null }),
          }),
        };
      }
      if (table === 'customers') {
        return {
          select: () => ({
            in: (_col: string, ids: string[]) =>
              Promise.resolve({ data: (tables.customers ?? []).filter((c) => ids.includes(c.id)), error: null }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

let stub: ReturnType<typeof makeSupabaseStub> | null = null;

// vi.mock calls are hoisted above every import in this file (including the
// static `./referralMetrics` import above), so loadReferralMetrics's internal
// `@/lib/supabase` import resolves to this stub — same convention as
// referrals.test.ts.
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => stub,
  getSupabaseClient: () => stub,
}));

beforeEach(() => {
  stub = null;
});

describe('loadReferralMetrics', () => {
  it('returns the empty metrics when Supabase is not configured', async () => {
    stub = null;
    expect(await loadReferralMetrics()).toEqual({
      totalReferrals: 0,
      bookedConversionRate: null,
      revenueInfluenced: { kind: 'count', count: 0 },
      topReferrers: [],
    });
  });

  it('returns the empty metrics when the referrals table has no rows', async () => {
    stub = makeSupabaseStub({ referrals: [] });
    const out = await loadReferralMetrics();
    expect(out.totalReferrals).toBe(0);
  });

  it('excludes a referral whose linked quote is a seeded is_test row (ledger #93 parity)', async () => {
    stub = makeSupabaseStub({
      referrals: [
        { id: 'r1', referrer_customer_id: 'c1', referee_quote_id: 'q1', status: 'booked' },
        { id: 'r2', referrer_customer_id: 'c1', referee_quote_id: 'q-test', status: 'booked' },
      ],
      quotes: [
        { id: 'q1', total: 2000, is_test: false },
        { id: 'q-test', total: 999999, is_test: true },
      ],
      customers: [{ id: 'c1', name: 'Jordan Smith' }],
    });
    const out = await loadReferralMetrics();
    expect(out.totalReferrals).toBe(1); // the is_test-linked row is fully excluded
    expect(out.revenueInfluenced).toEqual({ kind: 'usd', amountUsd: 2000 });
    expect(out.topReferrers[0]).toEqual({ customerId: 'c1', name: 'Jordan Smith', convertedCount: 1 });
  });

  it('resolves top-referrer names via a batched customers lookup', async () => {
    stub = makeSupabaseStub({
      referrals: [
        { id: 'r1', referrer_customer_id: 'c1', referee_quote_id: 'q1', status: 'booked' },
        { id: 'r2', referrer_customer_id: 'c2', referee_quote_id: null, status: 'pending' },
      ],
      quotes: [{ id: 'q1', total: 1500, is_test: false }],
      customers: [{ id: 'c1', name: 'Jordan Smith' }],
    });
    const out = await loadReferralMetrics();
    expect(out.totalReferrals).toBe(2);
    expect(out.bookedConversionRate).toBe(0.5);
    expect(out.topReferrers).toEqual([{ customerId: 'c1', name: 'Jordan Smith', convertedCount: 1 }]);
  });
});
