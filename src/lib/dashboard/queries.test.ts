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
  listInvoicesForWorkflowBoard,
  loadNeedsActionData,
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

describe('Test Quote isolation (#93)', () => {
  it('the dashboard chokepoint filters is_test = false', async () => {
    client = makeClient({ data: [], error: null });
    await listQuotesForDashboardResult(500);
    // THE single exclusion point — every dashboard metric inherits it.
    expect(client!.eq).toHaveBeenCalledWith('is_test', false);
  });

  // #176 — the same chokepoint excludes browse-only view-only quotes.
  it('the dashboard chokepoint also filters view_only = false', async () => {
    client = makeClient({ data: [], error: null });
    await listQuotesForDashboardResult(500);
    expect(client!.eq).toHaveBeenCalledWith('view_only', false);
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

// ─── Row 389 (S49): stale-invoice flag derivation ────────────────────────────
// A generic multi-table fake: `.limit()` resolves the table's row set, `.in()`
// resolves the quotes lookup (the shape both listInvoicesForWorkflowBoard and
// loadNeedsActionData join through — is_test/approval_snapshot).
function makeMultiTableClient(tables: Record<string, unknown[]>) {
  return {
    from(table: string) {
      const rows = tables[table] ?? [];
      const b = {
        select: () => b,
        order: () => b,
        limit: () => Promise.resolve({ data: rows, error: null }),
        in: (_col: string, ids: string[]) =>
          Promise.resolve({ data: rows.filter((r: unknown) => ids.includes((r as { id: string }).id)), error: null }),
      };
      return b;
    },
  };
}

describe('listInvoicesForWorkflowBoard — stale flag (row 389)', () => {
  it('flags an invoice whose quote carries paymentBlocked', async () => {
    client = makeMultiTableClient({
      invoices: [{ status: 'awaiting_payment', balance: 500, quote_id: 'q1' }],
      quotes: [{ id: 'q1', is_test: false, approval_snapshot: { paymentBlocked: { at: 'x' } } }],
    }) as unknown as ReturnType<typeof makeClient>;
    const invoices = await listInvoicesForWorkflowBoard();
    expect(invoices).toHaveLength(1);
    expect((invoices[0] as { stale?: boolean }).stale).toBe(true);
  });

  it('flags an invoice whose quote carries invoiceResyncFailed', async () => {
    client = makeMultiTableClient({
      invoices: [{ status: 'awaiting_payment', balance: 500, quote_id: 'q2' }],
      quotes: [{ id: 'q2', is_test: false, approval_snapshot: { invoiceResyncFailed: { invoiceId: 'i' } } }],
    }) as unknown as ReturnType<typeof makeClient>;
    const invoices = await listInvoicesForWorkflowBoard();
    expect((invoices[0] as { stale?: boolean }).stale).toBe(true);
  });

  it('leaves an ordinary invoice stale:false', async () => {
    client = makeMultiTableClient({
      invoices: [{ status: 'awaiting_payment', balance: 500, quote_id: 'q3' }],
      quotes: [{ id: 'q3', is_test: false, approval_snapshot: {} }],
    }) as unknown as ReturnType<typeof makeClient>;
    const invoices = await listInvoicesForWorkflowBoard();
    expect((invoices[0] as { stale?: boolean }).stale).toBe(false);
  });

  it('still excludes a test-quote invoice even when its snapshot is also stale (test-isolation wins)', async () => {
    client = makeMultiTableClient({
      invoices: [{ status: 'awaiting_payment', balance: 500, quote_id: 'q4' }],
      quotes: [{ id: 'q4', is_test: true, approval_snapshot: { paymentBlocked: { at: 'x' } } }],
    }) as unknown as ReturnType<typeof makeClient>;
    const invoices = await listInvoicesForWorkflowBoard();
    expect(invoices).toHaveLength(0);
  });
});

describe('loadNeedsActionData — stale flag (row 389)', () => {
  it('flags a stale invoice so the collect-balance nag can warn instead of quoting it as fact', async () => {
    client = makeMultiTableClient({
      jobs: [{ id: 'j1', quote_id: 'q1', status: 'requires_invoicing', created_at: '2026-08-01' }],
      invoices: [
        { id: 'inv1', job_id: 'j1', quote_id: 'q1', status: 'awaiting_payment', balance: 700, created_at: '2026-08-01' },
      ],
      quotes: [{ id: 'q1', approval_snapshot: { paymentBlocked: { at: 'x' } } }],
    }) as unknown as ReturnType<typeof makeClient>;
    const result = await loadNeedsActionData([]);
    expect(result.invoices).toHaveLength(1);
    expect((result.invoices[0] as { stale?: boolean }).stale).toBe(true);
  });

  it('leaves stale undefined/false when nothing is flagged on the linked quote', async () => {
    client = makeMultiTableClient({
      jobs: [{ id: 'j2', quote_id: 'q2', status: 'requires_invoicing', created_at: '2026-08-01' }],
      invoices: [
        { id: 'inv2', job_id: 'j2', quote_id: 'q2', status: 'awaiting_payment', balance: 400, created_at: '2026-08-01' },
      ],
      quotes: [{ id: 'q2', approval_snapshot: {} }],
    }) as unknown as ReturnType<typeof makeClient>;
    const result = await loadNeedsActionData([]);
    expect((result.invoices[0] as { stale?: boolean }).stale).toBe(false);
  });
});
