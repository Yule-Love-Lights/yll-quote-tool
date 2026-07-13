import { describe, it, expect, vi, beforeEach } from 'vitest';

// AUDIT FIX (dashboard-insights-error-visibility): prove the read surfaces
// query failures as `ok:false` (so Insights can show an error banner) instead
// of swallowing them into `[]`, and that hitting the row cap flags `capped`.

// Build a thenable query builder whose terminal `.limit()` resolves to the
// given Supabase-shaped { data, error }. Mirrors the chain in queries.ts:
// .from().select().eq().order().limit(). `eq` is captured so tests can assert
// the is_test isolation filter (ledger #93).
function makeClient(resolved: { data: unknown; error: unknown }) {
  const eq = vi.fn(() => builder);
  const builder = {
    select: vi.fn(() => builder),
    eq,
    order: vi.fn(() => builder),
    limit: vi.fn(() => Promise.resolve(resolved)),
  };
  return { from: vi.fn(() => builder), eq };
}

// Two-table fake for listJobsForWorkflowBoard: jobs resolve at `.limit()`, the
// quotes lookup resolves at `.in()`. Models the separate-query is_test derive.
function makeBoardClient(jobs: unknown[], quotes: Array<{ id: string; is_test: boolean }>) {
  return {
    from(table: string) {
      if (table === 'jobs') {
        const b = {
          select: () => b,
          order: () => b,
          limit: () => Promise.resolve({ data: jobs, error: null }),
        };
        return b;
      }
      const b = {
        select: () => b,
        in: (_col: string, ids: string[]) =>
          Promise.resolve({ data: quotes.filter((q) => ids.includes(q.id)), error: null }),
      };
      return b;
    },
  };
}

let client: ReturnType<typeof makeClient> | null = null;

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => client,
  getSupabaseClient: () => client,
}));

import {
  listQuotesForDashboardResult,
  listQuotesForDashboard,
  listJobsForWorkflowBoard,
} from './queries';

beforeEach(() => {
  client = null;
});

describe('listQuotesForDashboardResult', () => {
  it('returns ok:false (not an empty list) when the query errors', async () => {
    client = makeClient({ data: null, error: { message: 'boom' } });
    const result = await listQuotesForDashboardResult(500);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('boom');
  });

  it('returns ok:false when Supabase is not configured', async () => {
    client = null; // both client getters return null
    const result = await listQuotesForDashboardResult(500);
    expect(result.ok).toBe(false);
  });

  it('returns ok:true with rows on success', async () => {
    client = makeClient({ data: [{ id: 'a' }, { id: 'b' }], error: null });
    const result = await listQuotesForDashboardResult(500);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toHaveLength(2);
      expect(result.capped).toBe(false);
    }
  });

  it('flags capped=true when rows hit the row cap (lifetime aggregates truncated)', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: String(i) }));
    client = makeClient({ data: rows, error: null });
    const result = await listQuotesForDashboardResult(3); // limit === rows.length
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.capped).toBe(true);
      expect(result.limit).toBe(3);
    }
  });

  it('capped=false when fewer rows than the limit are returned', async () => {
    const rows = Array.from({ length: 2 }, (_, i) => ({ id: String(i) }));
    client = makeClient({ data: rows, error: null });
    const result = await listQuotesForDashboardResult(3);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.capped).toBe(false);
  });
});

describe('listQuotesForDashboard (backward-compatible wrapper)', () => {
  it('returns [] on error', async () => {
    client = makeClient({ data: null, error: { message: 'boom' } });
    expect(await listQuotesForDashboard(500)).toEqual([]);
  });

  it('returns the rows on success', async () => {
    client = makeClient({ data: [{ id: 'a' }], error: null });
    expect(await listQuotesForDashboard(500)).toHaveLength(1);
  });
});

describe('DASHBOARD_QUOTES_SELECT (WT-52)', () => {
  it('selects customer_address so dashboard surfaces can show the property address', async () => {
    client = makeClient({ data: [], error: null });
    await listQuotesForDashboardResult(500);
    // `from()` always returns the same builder object, so calling it again just
    // hands back a reference to inspect what the earlier real call recorded.
    const selectedColumns = client!.from().select.mock.calls[0][0] as string;
    expect(selectedColumns).toContain('customer_address');
  });
});

describe('Test Quote isolation (#93)', () => {
  it('the dashboard chokepoint filters is_test = false', async () => {
    client = makeClient({ data: [], error: null });
    await listQuotesForDashboardResult(500);
    // THE single exclusion point — every dashboard metric inherits it.
    expect(client!.eq).toHaveBeenCalledWith('is_test', false);
  });

  it('listJobsForWorkflowBoard drops jobs whose quote is a test quote', async () => {
    client = makeBoardClient(
      [
        { status: 'to_schedule', line_items: [], quote_id: 'real' },
        { status: 'to_schedule', line_items: [], quote_id: 'test' },
        { status: 'to_schedule', line_items: [], quote_id: null }, // kept (no quote)
      ],
      [
        { id: 'real', is_test: false },
        { id: 'test', is_test: true },
      ],
    ) as unknown as ReturnType<typeof makeClient>;
    const jobs = await listJobsForWorkflowBoard();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => (j as { quote_id?: string }).quote_id)).not.toContain('test');
  });
});
