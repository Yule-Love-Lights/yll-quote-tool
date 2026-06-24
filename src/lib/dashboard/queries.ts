import { getSupabaseClient, getSupabaseServiceClient } from '@/lib/supabase';
import type { DashboardQuote } from './types';

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
        'homeworks_sent_at, homeworks_signed_at, highlevel_contact_id',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('listQuotesForDashboard error:', error);
    return [];
  }
  return (data ?? []) as unknown as DashboardQuote[];
}
