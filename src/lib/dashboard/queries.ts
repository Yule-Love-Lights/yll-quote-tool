import { getSupabaseClient, getSupabaseServiceClient } from '@/lib/supabase';
import type { DashboardQuote } from './types';
import type { ViewEventRow } from './activity';
import type { WorkflowJob, WorkflowInvoice } from './workflowBoard';
import type { NeedsActionJob, NeedsActionInvoice } from './needsAction';

/**
 * Discriminated result for the dashboard quotes read. AUDIT FIX
 * (dashboard-insights-error-visibility): the old API swallowed query failures
 * into `[]`, so Insights/KPI math computed over an empty list and rendered
 * "—"/$0/0% with no way to tell "no data" from "the query broke". Callers that
 * care about correctness (Insights) should use `listQuotesForDashboardResult`
 * and surface `ok:false` as an error banner instead of zeros.
 *
 * `capped` (on the ok path) is true when the read returned exactly `limit`
 * rows — i.e. lifetime aggregates may be based on only the newest `limit`
 * quotes, so the UI should show a "based on newest N quotes" caveat.
 */
export type DashboardQuotesResult =
  | { ok: true; rows: DashboardQuote[]; capped: boolean; limit: number }
  | { ok: false; error: string };

const DASHBOARD_QUOTES_SELECT =
  // WT-52: customer_address so dashboard surfaces (worklist, needs-action,
  // customer detail) can show the property address, not just the name.
  'id, customer_name, customer_address, customer_email, customer_phone, total, ' +
  'created_at, quote_sent_at, customer_approved_at, deposit_paid_at, ' +
  'homeworks_sent_at, homeworks_signed_at, highlevel_contact_id, ' +
  'service_type, ' +
  // WT-52: the customer detail page's quote-history table groups by property
  // for a multi-address (commercial) customer. Needs each quote's address.
  'customer_address, ' +
  // B7 fix: status + viewed_at are required so deriveStatus can identify
  // terminal states (cancelled/declined/lost) that timestamps alone can't
  // express. Without status, a cancelled-but-deposited order falls through
  // deposit_paid_at→'booked' and inflates revenue and the board.
  'status, viewed_at, ' +
  // Rebook Part D: customer_id feeds the "Rebook last season" button on the
  // customer detail page. NULL on quotes saved before the backfill runs; the
  // button hides itself when no customer_id is resolvable across the quotes.
  'customer_id, ' +
  // BUG-2 (S22): the sequential display number (#83) so the customer detail
  // history + activity feed show `#1010` instead of the raw UUID prefix.
  'quote_number';

/**
 * Fetch quotes for the dashboard, returning a discriminated result so callers
 * can distinguish a genuine empty table from a failed query. Service client
 * preferred (same pattern as `listQuotes` in `lib/quotes.ts`) so admin-side
 * reads never trip RLS.
 *
 * Server-only. Do NOT call from a client component.
 */
export async function listQuotesForDashboardResult(limit = 500): Promise<DashboardQuotesResult> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await sb
    .from('quotes')
    .select(DASHBOARD_QUOTES_SELECT)
    // Test Quote isolation (ledger #93): THE single chokepoint. Every dashboard
    // surface — KPIs, customers list, worklist, workflow board, insights,
    // serviceMetrics — composes from these rows, so excluding is_test here keeps
    // simulated test data out of every metric in one place.
    .eq('is_test', false)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listQuotesForDashboard error:', error);
    return { ok: false, error: error.message };
  }
  const rows = (data ?? []) as unknown as DashboardQuote[];
  // capped = hit the row cap, so lifetime aggregates are over only the newest
  // `limit` quotes. Interim caveat until aggregates are computed server-side.
  return { ok: true, rows, capped: rows.length === limit, limit };
}

/**
 * Backward-compatible accessor: returns just the rows ([] on failure or when
 * Supabase isn't configured). Kept for callers that don't surface errors
 * (customers list/detail). New error-sensitive callers should prefer
 * `listQuotesForDashboardResult`.
 *
 * Server-only. Do NOT call from a client component.
 */
export async function listQuotesForDashboard(limit = 500): Promise<DashboardQuote[]> {
  const result = await listQuotesForDashboardResult(limit);
  return result.ok ? result.rows : [];
}

/**
 * Per-view events for the given quotes (customer activity feed). Newest first.
 * BEST-EFFORT: returns [] on any error — including the quote_view_events table
 * not existing yet — so the customer page still renders (showing lifecycle
 * events) before this feature's migration is applied. Server-only.
 */
// Cap on view rows per customer. Ordered newest-first, so hitting the cap drops
// only the OLDEST views — the feed still shows the most recent ones. 1000 opens
// for one customer is well beyond any realistic case; if it's ever hit we log it.
const VIEW_EVENTS_LIMIT = 1000;

/**
 * Jobs for the Workflow board's Jobs column (ledger #83 Phase 2). Read-only,
 * server-side aggregation source — just `status` + `line_items` (the board
 * sums line-item amounts for the column total). BEST-EFFORT: returns [] on any
 * error — including the `jobs` table not existing yet — so the dashboard still
 * renders (Jobs column shows zeros) before the 2026-06-27-jobs.sql migration is
 * applied. Mirrors getViewEventsForQuotes. Server-only.
 */
export async function listJobsForWorkflowBoard(limit = 1000): Promise<WorkflowJob[]> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from('jobs')
      .select('status, line_items, quote_id')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.warn('listJobsForWorkflowBoard (table not migrated yet?):', error.message);
      return [];
    }
    const jobs = (data ?? []) as Array<WorkflowJob & { quote_id: string | null }>;
    // Test Quote isolation (ledger #93): a test quote's job is a REAL jobs row,
    // so it would inflate the board's Jobs column unless excluded. is_test lives
    // only on the quote — derive it via the quote link (separate query + Set,
    // the same pattern the inventory cards / supplier PO use). Jobs with no
    // quote_id (shouldn't happen for the board) are kept.
    const quoteIds = [...new Set(jobs.map((j) => j.quote_id).filter((x): x is string => !!x))];
    const testQuoteIds = new Set<string>();
    if (quoteIds.length) {
      const { data: qrows } = await sb.from('quotes').select('id, is_test').in('id', quoteIds);
      for (const q of (qrows ?? []) as Array<{ id: string; is_test: boolean | null }>) {
        if (q.is_test) testQuoteIds.add(q.id);
      }
    }
    return jobs.filter((j) => !(j.quote_id && testQuoteIds.has(j.quote_id)));
  } catch (err) {
    console.warn('listJobsForWorkflowBoard failed:', err);
    return [];
  }
}

/**
 * Invoices for the Workflow board's Invoices column (ledger #83 Phase 3). Read-only,
 * server-side aggregation source — just `status` + `balance` (the board sums the
 * outstanding balance for the column total). BEST-EFFORT: returns [] on any error —
 * including the `invoices` table not existing yet — so the dashboard still renders
 * (Invoices column shows zeros) before the 2026-06-27-invoices.sql migration is
 * applied. Mirrors listJobsForWorkflowBoard, including the #93 test-quote isolation
 * (a test quote's invoice is a real invoices row; exclude it via the quote link).
 * Server-only.
 */
export async function listInvoicesForWorkflowBoard(limit = 1000): Promise<WorkflowInvoice[]> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from('invoices')
      .select('status, balance, quote_id')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.warn('listInvoicesForWorkflowBoard (table not migrated yet?):', error.message);
      return [];
    }
    const invoices = (data ?? []) as Array<WorkflowInvoice & { quote_id: string | null }>;
    // Test Quote isolation (ledger #93): a test quote's invoice is a REAL invoices
    // row, so it would inflate the board's Invoices column unless excluded. is_test
    // lives only on the quote — derive it via the quote link (same pattern as
    // listJobsForWorkflowBoard). Invoices with no quote_id are kept.
    const quoteIds = [...new Set(invoices.map((i) => i.quote_id).filter((x): x is string => !!x))];
    const testQuoteIds = new Set<string>();
    if (quoteIds.length) {
      const { data: qrows } = await sb.from('quotes').select('id, is_test').in('id', quoteIds);
      for (const q of (qrows ?? []) as Array<{ id: string; is_test: boolean | null }>) {
        if (q.is_test) testQuoteIds.add(q.id);
      }
    }
    return invoices.filter((i) => !(i.quote_id && testQuoteIds.has(i.quote_id)));
  } catch (err) {
    console.warn('listInvoicesForWorkflowBoard failed:', err);
    return [];
  }
}

export async function getViewEventsForQuotes(quoteIds: string[]): Promise<ViewEventRow[]> {
  if (quoteIds.length === 0) return [];
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from('quote_view_events')
      // select('*') (not a named list) so the `kind` column is included when it
      // exists but the query doesn't error before that migration is applied.
      .select('*')
      .in('quote_id', quoteIds)
      .order('viewed_at', { ascending: false })
      .limit(VIEW_EVENTS_LIMIT);
    if (error) {
      console.warn('getViewEventsForQuotes (table not migrated yet?):', error.message);
      return [];
    }
    const rows = (data ?? []) as unknown as ViewEventRow[];
    if (rows.length === VIEW_EVENTS_LIMIT) {
      console.warn(
        `getViewEventsForQuotes: hit the ${VIEW_EVENTS_LIMIT}-row cap; oldest views are not shown.`,
      );
    }
    return rows;
  } catch (err) {
    console.warn('getViewEventsForQuotes failed:', err);
    return [];
  }
}

// ─── Needs-Action data loader ─────────────────────────────────────────────────

/**
 * The combined data snapshot that `buildNeedsAction` needs: the same quote rows
 * the dashboard already loads (passed in from the caller to avoid a second read),
 * plus a lightweight jobs + invoices read.
 *
 * Callers pass `quotes` from an existing `listQuotesForDashboard` call — no
 * second quotes query. Jobs + invoices are fetched here in parallel (Promise.all)
 * so the total cost is one additional round-trip pair, not N+1.
 *
 * BEST-EFFORT: jobs/invoices return [] on any error (tables may not exist on
 * older branches) — matches the same defensive pattern as `listJobsForWorkflowBoard`.
 * Server-only.
 */
export async function loadNeedsActionData(
  quotes: DashboardQuote[],
  limit = 500,
): Promise<{ quotes: DashboardQuote[]; jobs: NeedsActionJob[]; invoices: NeedsActionInvoice[] }> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return { quotes, jobs: [], invoices: [] };

  const [jobsResult, invoicesResult] = await Promise.all([
    sb
      .from('jobs')
      .select('id, quote_id, status, created_at')
      .order('created_at', { ascending: false })
      .limit(limit),
    sb
      .from('invoices')
      .select('id, job_id, quote_id, status, balance, created_at')
      .order('created_at', { ascending: false })
      .limit(limit),
  ]);

  if (jobsResult.error) {
    console.warn('loadNeedsActionData jobs (table not migrated yet?):', jobsResult.error.message);
  }
  if (invoicesResult.error) {
    console.warn(
      'loadNeedsActionData invoices (table not migrated yet?):',
      invoicesResult.error.message,
    );
  }

  const jobs = (jobsResult.data ?? []) as unknown as NeedsActionJob[];
  const invoices = (invoicesResult.data ?? []) as unknown as NeedsActionInvoice[];

  return { quotes, jobs, invoices };
}
