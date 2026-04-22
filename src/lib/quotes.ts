import { getSupabaseClient } from './supabase';
import { QuoteInputs, QuoteResult } from './pricing/pricingEngine';

export type Customer = {
  name: string;
  address: string;
  phone?: string;
  email?: string;
};

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
      customer_name: customer.name,
      customer_address: customer.address,
      customer_phone: customer.phone ?? null,
      customer_email: customer.email ?? null,
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
