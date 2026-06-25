import { getSupabaseClient, getSupabaseServiceClient } from '@/lib/supabase';
import type { DashboardQuote } from './types';
import type { ViewEventRow } from './activity';

/**
 * Fetch quotes for the dashboard: id, customer info, total, and the full
 * lifecycle timestamp chain. Service client preferred (same pattern as
 * `listQuotes` in `lib/quotes.ts`) so admin-side reads never trip RLS.
 *
 * Server-only. Do NOT call from a client component.
 */
export async function listQuotesForDashboard(limit = 500): Promise<DashboardQuote[]> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_email, customer_phone, total, ' +
        'created_at, quote_sent_at, customer_approved_at, ' +
        'homeworks_sent_at, homeworks_signed_at, highlevel_contact_id, ' +
        'service_type',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listQuotesForDashboard error:', error);
    return [];
  }
  return (data ?? []) as unknown as DashboardQuote[];
}

/**
 * Per-view events for the given quotes (customer activity feed). Newest first.
 * BEST-EFFORT: returns [] on any error — including the quote_view_events table
 * not existing yet — so the customer page still renders (showing lifecycle
 * events) before this feature's migration is applied. Server-only.
 */
export async function getViewEventsForQuotes(quoteIds: string[]): Promise<ViewEventRow[]> {
  if (quoteIds.length === 0) return [];
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return [];
  try {
    const { data, error } = await sb
      .from('quote_view_events')
      .select('quote_id, viewed_at')
      .in('quote_id', quoteIds)
      .order('viewed_at', { ascending: false })
      .limit(1000);
    if (error) {
      console.warn('getViewEventsForQuotes (table not migrated yet?):', error.message);
      return [];
    }
    return (data ?? []) as unknown as ViewEventRow[];
  } catch (err) {
    console.warn('getViewEventsForQuotes failed:', err);
    return [];
  }
}
