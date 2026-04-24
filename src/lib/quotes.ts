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
};

export async function listQuotes(limit = 500): Promise<QuoteListItem[]> {
  // Use service client so admin listings ignore RLS restrictions.
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('quotes')
    .select('id, customer_name, customer_address, customer_phone, customer_email, total, created_at')
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
