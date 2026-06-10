import { getSupabaseClient, getSupabaseServiceClient } from './supabase';
import { QuoteInputs, QuoteResult } from './pricing/pricingEngine';

export type QuoteListItem = {
  id: string;
  customer_name: string | null;
  customer_address: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  total: number | null;
  created_at: string;
  // Lifecycle flags. Admin UI uses these to show "Sent" / "Approved" badges
  // and to short-circuit the "Send to customer" button when already sent.
  quote_sent_at: string | null;
  customer_approved_at: string | null;
};

export async function listQuotes(limit = 500): Promise<QuoteListItem[]> {
  // Use service client so admin listings ignore RLS restrictions.
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_address, customer_phone, customer_email, total, created_at, quote_sent_at, customer_approved_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('Supabase listQuotes error:', error);
    return [];
  }
  return (data ?? []) as QuoteListItem[];
}

export async function deleteQuote(id: string): Promise<void> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) throw new Error('Supabase not configured');
  const { error } = await sb.from('quotes').delete().eq('id', id);
  if (error) throw new Error(`deleteQuote: ${error.message}`);
}

export async function deleteAllQuotes(): Promise<number> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) throw new Error('Supabase not configured');
  // Supabase requires a filter on bulk deletes — use an always-true UUID
  // comparison. Returns count of deleted rows.
  const { error, count } = await sb
    .from('quotes')
    .delete({ count: 'exact' })
    .not('id', 'is', null);
  if (error) throw new Error(`deleteAllQuotes: ${error.message}`);
  return count ?? 0;
}

// Customer fields are all optional while we're in testing mode. Empty or
// missing values are persisted as "Anonymous" / null so admins can still
// sort/filter without blowing up on NOT NULL constraints.
export type Customer = {
  name?: string;
  address?: string;
  phone?: string;
  email?: string;
};

function blankToNull(v: string | undefined): string | null {
  if (!v) return null;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : null;
}

export async function saveQuote(
  customer: Customer,
  inputs: QuoteInputs,
  result: QuoteResult,
): Promise<{ id: string } | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('quotes')
    .insert({
      customer_name: blankToNull(customer.name) ?? 'Anonymous',
      customer_address: blankToNull(customer.address) ?? '(no address)',
      customer_phone: blankToNull(customer.phone),
      customer_email: blankToNull(customer.email),
      inputs,
      result,
      total: result.total,
    })
    .select('id')
    .single();

  if (error) {
    console.error('Supabase saveQuote error:', error);
    return null;
  }
  return { id: data.id };
}

// Re-price an existing quote IN PLACE (no new row). Used when the operator
// changes the recommended roofline in the builder breakdown (#17 Phase 1b)
// and when recalculating from the edit flow (/quote/[id], #31). Passing
// `customer` also persists edited customer fields (same sentinel defaults
// as saveQuote so the row never regresses to NULL name/address).
export async function updateQuote(
  id: string,
  inputs: QuoteInputs,
  result: QuoteResult,
  customer?: Customer,
): Promise<{ id: string } | null> {
  const supabase = getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('quotes')
    .update({
      inputs,
      result,
      total: result.total,
      ...(customer
        ? {
            customer_name: blankToNull(customer.name) ?? 'Anonymous',
            customer_address: blankToNull(customer.address) ?? '(no address)',
            customer_phone: blankToNull(customer.phone),
            customer_email: blankToNull(customer.email),
          }
        : {}),
    })
    .eq('id', id)
    .select('id')
    .single();

  if (error) {
    console.error('Supabase updateQuote error:', error);
    return null;
  }
  return { id: data.id };
}

// The raw row the EDIT flow needs (/quote/[id], #31): stored customer columns +
// the exact QuoteInputs/QuoteResult jsonb the builder hydrates from. Distinct
// from loadPortalQuote, which shapes the same row for the customer portal.
export type QuoteRaw = {
  id: string;
  customer_name: string | null;
  customer_address: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  inputs: Partial<QuoteInputs>;
  result: QuoteResult | null;
  quote_sent_at: string | null;
  customer_approved_at: string | null;
};

export async function getQuoteRaw(id: string): Promise<QuoteRaw | null> {
  // Service client first: the edit page is staff-side (like the admin list).
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return null;
  const { data, error } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_address, customer_phone, customer_email, inputs, result, quote_sent_at, customer_approved_at',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('Supabase getQuoteRaw error:', error);
    return null;
  }
  return (data as QuoteRaw | null) ?? null;
}
