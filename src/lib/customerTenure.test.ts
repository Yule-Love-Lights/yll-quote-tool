import { describe, it, expect, beforeEach, vi } from 'vitest';

// Fixed "now" for deterministic time math (mirrors src/lib/dashboard/metrics.test.ts).
const NOW = new Date('2026-07-28T12:00:00Z');

const { sbRef, getCustomerMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  getCustomerMock: vi.fn(),
}));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => sbRef.current,
}));

vi.mock('./customers', () => ({
  getCustomer: getCustomerMock,
}));

import {
  deriveTenureYears,
  tenureChipLabel,
  tenureHeaderLabel,
  getTenureQuotes,
  getCustomerTenure,
  type TenureQuoteSource,
} from './customerTenure';

function q(over: Partial<TenureQuoteSource> = {}): TenureQuoteSource {
  return { deposit_paid_at: null, legacy_rebook: false, ...over };
}

describe('deriveTenureYears — booked years', () => {
  it('derives one year per deposit_paid_at, deduped across multiple quotes in the same year', () => {
    const result = deriveTenureYears(
      [
        q({ deposit_paid_at: '2024-11-01T00:00:00Z' }),
        q({ deposit_paid_at: '2024-12-15T00:00:00Z' }), // same year, no dup
        q({ deposit_paid_at: '2023-10-01T00:00:00Z' }),
      ],
      [],
      NOW,
    );
    expect(result.years).toEqual([2023, 2024]);
    expect(result.count).toBe(2);
    expect(result.derivedYears).toEqual([2023, 2024]);
    expect(result.manualYears).toEqual([]);
  });

  it('ignores a quote with no deposit_paid_at and no legacy_rebook', () => {
    const result = deriveTenureYears([q()], [], NOW);
    expect(result.years).toEqual([]);
  });
});

describe('deriveTenureYears — legacy rebook rule', () => {
  it('a legacy_rebook=true quote always counts as 2025, regardless of its own dates', () => {
    // No deposit_paid_at at all — the row's OWN dates (if any) must never be
    // read; legacy_rebook rows are migration drafts stamped with 2026
    // migration timestamps, not the real 2025 job date.
    const result = deriveTenureYears([q({ legacy_rebook: true, deposit_paid_at: null })], [], NOW);
    expect(result.years).toEqual([2025]);
    expect(result.derivedYears).toEqual([2025]);
  });

  it('a legacy_rebook row with an unrelated deposit_paid_at still adds 2025 alongside the deposit year', () => {
    const result = deriveTenureYears(
      [q({ legacy_rebook: true, deposit_paid_at: '2026-03-01T00:00:00Z' })],
      [],
      NOW,
    );
    expect(result.years).toEqual([2025, 2026]);
  });

  it('legacy_rebook=false or absent contributes nothing on its own', () => {
    expect(deriveTenureYears([q({ legacy_rebook: false })], [], NOW).years).toEqual([]);
    expect(deriveTenureYears([{ deposit_paid_at: null }], [], NOW).years).toEqual([]);
  });
});

describe('deriveTenureYears — manual union + dedupe', () => {
  it('unions manual years with derived years, sorted ascending, deduped', () => {
    const result = deriveTenureYears(
      [q({ deposit_paid_at: '2024-11-01T00:00:00Z' })],
      [2022, 2024, 2022], // 2024 overlaps derived; 2022 duplicated in the input itself
      NOW,
    );
    expect(result.years).toEqual([2022, 2024]);
    expect(result.count).toBe(2);
  });

  it('marks a manual-only year as removable (manualYears) and a derived year as not (derivedYears)', () => {
    const result = deriveTenureYears(
      [q({ deposit_paid_at: '2024-11-01T00:00:00Z' })],
      [2022],
      NOW,
    );
    expect(result.manualYears).toEqual([2022]);
    expect(result.derivedYears).toEqual([2024]);
  });

  it('a year that is BOTH manually added and derived is treated as derived (not removable)', () => {
    const result = deriveTenureYears(
      [q({ deposit_paid_at: '2024-11-01T00:00:00Z' })],
      [2024],
      NOW,
    );
    expect(result.manualYears).toEqual([]);
    expect(result.derivedYears).toEqual([2024]);
  });
});

describe('deriveTenureYears — junk manual values ignored', () => {
  it('drops non-array manual_years entirely', () => {
    expect(deriveTenureYears([], null, NOW).years).toEqual([]);
    expect(deriveTenureYears([], undefined, NOW).years).toEqual([]);
    expect(deriveTenureYears([], 'not-an-array', NOW).years).toEqual([]);
    expect(deriveTenureYears([], { 2022: true }, NOW).years).toEqual([]);
  });

  it('drops individual junk entries but keeps the valid ones', () => {
    const result = deriveTenureYears([], [2023, '2024', 2024.5, null, {}, [], 2022], NOW);
    expect(result.years).toEqual([2022, 2023]);
  });

  it('drops years before the plausible floor (2022) and any year in the future', () => {
    const result = deriveTenureYears([], [2021, 2022, 2027, 2026], NOW); // NOW is 2026
    expect(result.years).toEqual([2022, 2026]);
  });
});

describe('deriveTenureYears — empty → new customer', () => {
  it('returns an empty result with no quotes and no manual years', () => {
    const result = deriveTenureYears([], [], NOW);
    expect(result).toEqual({ years: [], count: 0, manualYears: [], derivedYears: [] });
  });
});

describe('tenureChipLabel / tenureHeaderLabel', () => {
  it('chip label is null when there is no tenure history', () => {
    expect(tenureChipLabel(deriveTenureYears([], [], NOW))).toBeNull();
  });

  it('chip label uses an ordinal + the year list', () => {
    const result = deriveTenureYears(
      [q({ deposit_paid_at: '2023-01-01T00:00:00Z' }), q({ deposit_paid_at: '2024-01-01T00:00:00Z' }), q({ deposit_paid_at: '2025-01-01T00:00:00Z' })],
      [],
      NOW,
    );
    expect(tenureChipLabel(result)).toBe('3rd year — 2023 · 2024 · 2025');
  });

  it('ordinal suffixes handle the 11/12/13 special case', () => {
    // Floor-anchored at 2022 (MIN_TENURE_YEAR) needs a "now" past 2032 for all
    // 11 years to survive validManualYears' currentYear cap — NOW (2026) is
    // too early, so this test uses its own later instant.
    const laterNow = new Date('2036-07-28T12:00:00Z');
    const years = Array.from({ length: 11 }, (_, i) => 2022 + i); // 2022..2032, count 11
    const result = deriveTenureYears([], years, laterNow);
    expect(tenureChipLabel(result)?.startsWith('11th year')).toBe(true);
  });

  it('header label reads "New customer" when empty, else the count + years', () => {
    expect(tenureHeaderLabel(deriveTenureYears([], [], NOW))).toBe('New customer');
    const result = deriveTenureYears([q({ deposit_paid_at: '2024-01-01T00:00:00Z' })], [], NOW);
    expect(tenureHeaderLabel(result)).toBe('1 year with YLL — 2024');
    const result2 = deriveTenureYears(
      [q({ deposit_paid_at: '2024-01-01T00:00:00Z' }), q({ deposit_paid_at: '2025-01-01T00:00:00Z' })],
      [],
      NOW,
    );
    expect(tenureHeaderLabel(result2)).toBe('2 years with YLL — 2024 · 2025');
  });
});

// ─── IO wrapper: a minimal chainable Supabase fake (mirrors the `makeSb`
// pattern in src/app/api/quotes/[id]/view-only/route.test.ts) ───────────────

type QuoteRow = {
  id: string;
  customer_id?: string | null;
  highlevel_contact_id?: string | null;
  deposit_paid_at: string | null;
  legacy_rebook: boolean | null;
  is_test?: boolean;
  view_only?: boolean;
};

// `.from()` must return a FRESH builder (its own filters array) on every
// call — getTenureQuotes calls it twice (once per id branch), and real
// supabase-js starts a new query each time; a shared filters array would
// leak the first branch's `.eq()`s into the second.
function makeSb(rows: QuoteRow[]) {
  function makeBuilder() {
    const filters: Array<(r: QuoteRow) => boolean> = [];
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        filters.push((r) => (r as unknown as Record<string, unknown>)[col] === val);
        return builder;
      },
      then: (resolve: (v: { data: QuoteRow[]; error: null }) => unknown) =>
        resolve({ data: rows.filter((r) => filters.every((f) => f(r))), error: null }),
    };
    return builder;
  }
  return { from: () => makeBuilder() };
}

describe('getTenureQuotes — id matching + exclusions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('matches by customer_id, excludes is_test and view_only rows', async () => {
    sbRef.current = makeSb([
      { id: 'a', customer_id: 'cust-1', deposit_paid_at: '2024-01-01', legacy_rebook: false, is_test: false, view_only: false },
      { id: 'b', customer_id: 'cust-1', deposit_paid_at: '2025-01-01', legacy_rebook: false, is_test: true, view_only: false },
    ]);
    const rows = await getTenureQuotes('cust-1', null);
    expect((rows as QuoteRow[]).map((r) => r.id)).toEqual(['a']);
  });

  it('dedupes a row matched via BOTH customer_id and highlevel_contact_id', async () => {
    sbRef.current = makeSb([
      { id: 'a', customer_id: 'cust-1', highlevel_contact_id: 'hl-1', deposit_paid_at: '2024-01-01', legacy_rebook: false, is_test: false, view_only: false },
    ]);
    const rows = await getTenureQuotes('cust-1', 'hl-1');
    expect(rows).toHaveLength(1);
  });

  it('returns [] when neither id is known (no linked customer)', async () => {
    sbRef.current = makeSb([]);
    expect(await getTenureQuotes(null, null)).toEqual([]);
  });
});

describe('getCustomerTenure — combines quotes + manual_years', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCustomerMock.mockReset();
  });

  it('unions the customer row manual_years with derived quote years', async () => {
    sbRef.current = makeSb([
      { id: 'a', customer_id: 'cust-1', deposit_paid_at: '2024-01-01', legacy_rebook: false, is_test: false, view_only: false },
    ]);
    getCustomerMock.mockResolvedValue({ id: 'cust-1', manual_years: [2022] });
    const result = await getCustomerTenure('cust-1', null, NOW);
    expect(result.years).toEqual([2022, 2024]);
  });

  it('returns the empty result and skips the customer read when there is no linked customer id', async () => {
    sbRef.current = makeSb([]);
    const result = await getCustomerTenure(null, null, NOW);
    expect(result).toEqual({ years: [], count: 0, manualYears: [], derivedYears: [] });
    expect(getCustomerMock).not.toHaveBeenCalled();
  });
});
