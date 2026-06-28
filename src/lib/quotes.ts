import { getSupabaseClient, getSupabaseServiceClient } from './supabase';
import { QuoteInputs, QuoteResult } from './pricing/pricingEngine';
import { ServiceType, DEFAULT_SERVICE_TYPE } from './serviceType';
import { deleteDesign, deleteDesignsForQuote } from './designs';
import { allocateNumber } from './displayId';
import type { QuoteStatus } from './quoteStatus';

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
  // Valor deposit-paid timestamp — set = "Booked" (the #38 deposit flow). Read
  // by deriveStatus() so the admin list shows the Booked badge.
  deposit_paid_at: string | null;
  // View receipt (#68): when the customer opened their portal link. Admin shows
  // a "Viewed" badge (with the count + last-open time on hover).
  viewed_at: string | null;
  last_viewed_at: string | null;
  view_count: number | null;
  // Explicit lifecycle status (ledger #83 Phase 1). NULL on legacy / pre-migration
  // rows — surfaces fall back to deriveStatus(row) from the timestamps above. The
  // decline reason + sequential display number land alongside it.
  status: QuoteStatus | null;
  decline_reason: string | null;
  quote_number: number | null;
};

export async function listQuotes(limit = 500): Promise<QuoteListItem[]> {
  // Use service client so admin listings ignore RLS restrictions.
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_address, customer_phone, customer_email, total, created_at, quote_sent_at, customer_approved_at, deposit_paid_at, viewed_at, last_viewed_at, view_count, status, decline_reason, quote_number',
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
  // Audit fix (customer-photo-retention-deletion): erase the linked design +
  // its private bucket images FIRST, before the quote row. The designs FK is
  // `on delete set null`, so deleting only the quote would orphan the design row
  // and leave the customer's house photo + satellite image in storage forever.
  // Best-effort: a design-cleanup failure is logged inside deleteDesignsForQuote
  // and must not block the quote delete the operator asked for.
  await deleteDesignsForQuote(id);
  const { error } = await sb.from('quotes').delete().eq('id', id);
  if (error) throw new Error(`deleteQuote: ${error.message}`);
}

export async function deleteAllQuotes(): Promise<number> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) throw new Error('Supabase not configured');
  // Audit fix (customer-photo-retention-deletion): erase EVERY design + its
  // private bucket images before bulk-deleting the quotes, so a "delete all"
  // doesn't leave a bucket full of orphaned customer photos. We delete designs
  // linked to a quote (quote_id not null); unlinked, never-Calculated designs
  // are intentionally left (they belong to no quote and aren't dropped by a
  // quote wipe — out of scope for this fix, see decisionsForReviewer).
  const { data: linked } = await sb.from('designs').select('id').not('quote_id', 'is', null);
  for (const row of (linked ?? []) as Array<{ id: string }>) {
    await deleteDesign(row.id as string);
  }
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
  serviceType: ServiceType = DEFAULT_SERVICE_TYPE,
): Promise<{ id: string } | null> {
  // Service client first so the write bypasses RLS (enabled on quotes, #90); the
  // anon fallback keeps dev (no service key) working.
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return null;

  // Sequential display number (ledger #83, SPEC §4.6) — allocated once, on first
  // save. Best-effort: a failed allocation (RPC/sequence missing, e.g. before the
  // 2026-06-27-quote-status migration applies) must NOT block the save — the
  // column is nullable and the truncated-UUID display (#77) still works. Omitting
  // the key entirely on failure also keeps this insert working against a DB that
  // pre-dates the migration.
  let quoteNumber: number | null = null;
  try {
    quoteNumber = await allocateNumber('quote_number_seq');
  } catch (err) {
    console.warn('saveQuote: quote_number allocation skipped:', err);
  }

  const { data, error } = await supabase
    .from('quotes')
    .insert({
      customer_name: blankToNull(customer.name) ?? 'Anonymous',
      customer_address: blankToNull(customer.address) ?? '(no address)',
      customer_phone: blankToNull(customer.phone),
      customer_email: blankToNull(customer.email),
      service_type: serviceType,
      inputs,
      result,
      total: result.total,
      // A freshly-saved quote is a draft until staff send it (ledger #83). The
      // forward lifecycle is then re-derivable from the timestamps, but stamping
      // it here makes the explicit-status read path correct from row one.
      status: 'draft' satisfies QuoteStatus,
      ...(quoteNumber != null ? { quote_number: quoteNumber } : {}),
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
  // Only written when provided — omitting it leaves the stored service_type
  // untouched (so a re-price that doesn't carry it can't reset the column).
  serviceType?: ServiceType,
): Promise<{ id: string } | null> {
  // Service client first so the write bypasses RLS (enabled on quotes, #90).
  const supabase = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('quotes')
    .update({
      inputs,
      result,
      total: result.total,
      ...(serviceType ? { service_type: serviceType } : {}),
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
  service_type: ServiceType | null;
  inputs: Partial<QuoteInputs>;
  result: QuoteResult | null;
  quote_sent_at: string | null;
  customer_approved_at: string | null;
  // Explicit lifecycle status + display number (ledger #83 Phase 1). NULL on
  // legacy / pre-migration rows.
  status: QuoteStatus | null;
  decline_reason: string | null;
  quote_number: number | null;
};

export async function getQuoteRaw(id: string): Promise<QuoteRaw | null> {
  // Service client first: the edit page is staff-side (like the admin list).
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return null;
  const { data, error } = await sb
    .from('quotes')
    .select(
      'id, customer_name, customer_address, customer_phone, customer_email, service_type, inputs, result, quote_sent_at, customer_approved_at, status, decline_reason, quote_number',
    )
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('Supabase getQuoteRaw error:', error);
    return null;
  }
  return (data as QuoteRaw | null) ?? null;
}
