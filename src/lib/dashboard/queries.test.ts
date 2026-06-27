import { describe, it, expect, vi, beforeEach } from 'vitest';

// AUDIT FIX (dashboard-insights-error-visibility): prove the read surfaces
// query failures as `ok:false` (so Insights can show an error banner) instead
// of swallowing them into `[]`, and that hitting the row cap flags `capped`.

// Build a thenable query builder whose terminal `.limit()` resolves to the
// given Supabase-shaped { data, error }. Mirrors the chain in queries.ts:
// .from().select().order().limit()
function makeClient(resolved: { data: unknown; error: unknown }) {
  const builder = {
    select: vi.fn(() => builder),
    order: vi.fn(() => builder),
    limit: vi.fn(() => Promise.resolve(resolved)),
  };
  return { from: vi.fn(() => builder) };
}

let client: ReturnType<typeof makeClient> | null = null;

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => client,
  getSupabaseClient: () => client,
}));

import {
  listQuotesForDashboardResult,
  listQuotesForDashboard,
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
