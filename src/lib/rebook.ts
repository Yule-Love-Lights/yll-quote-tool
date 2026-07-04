import { getSupabaseClient, getSupabaseServiceClient } from './supabase';
import { cloneDesignToNewQuote } from './designs';

// "Rebook last season" (ledger #83, Phase 5). One click clones a customer/
// property's last APPROVED quote — its priced inputs/result + its design (scene
// + base photo) — into a fresh DRAFT quote for the new season. See
// docs/jobber-flow/SPEC.md §4.5.
//
// Depends on the customers/properties identity (src/lib/customers.ts): the
// source quote is found by quotes.customer_id, so the backfill must have linked
// the customer's history first.
//
// The pure builder (buildRebookInsert) is unit-tested without a DB; the DB
// orchestration (rebookLastSeason) is a thin clone + design copy.

// The identity/pricing columns carried from the source quote into the clone.
export type RebookSource = {
  customer_name: string | null;
  customer_address: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  highlevel_contact_id?: string | null;
  service_type?: string | null;
  inputs: unknown;
  result: { total?: number } | null;
  customer_id?: string | null;
  property_id?: string | null;
  is_test?: boolean | null;
};

// PURE — the column set a rebooked quote INSERTs. Copies the customer + the
// priced inputs/result/service_type + the customer/property link, and carries
// NOTHING from the lifecycle (no quote_sent_at / customer_approved_at /
// deposit_paid_at, no approval_snapshot), so the clone lands as a fresh draft.
// status is set explicitly to 'draft' to match saveQuote's invariant (a persisted
// status, not a NULL that relies on the deriveStatus fallback) now that the
// status spine has merged. The new id + created_at come from the DB defaults.
// service_type is only set when present so the clone can't reset the column to NULL.
// A rebooked permanent/event quote must re-price at CURRENT rates when staff click
// Calculate on the new draft — result.permanentRatesSnapshot / result.eventRatesSnapshot
// are the rate-freeze guard for OUTSTANDING quotes, NOT a brand-new season's draft.
// Strip BOTH from the carried result so the /api/quote update branch's price source
// falls through to live app_settings rates (it reads existing?.result?.<vertical>RatesSnapshot
// ?? live for whichever vertical). rebookLastSeason doesn't filter by service_type, so
// the source can be either vertical. No-op for holiday results (no snapshot present).
function stripRatesSnapshots(result: RebookSource['result']): RebookSource['result'] {
  if (!result || typeof result !== 'object') return result;
  const rest = { ...(result as Record<string, unknown>) };
  delete rest.permanentRatesSnapshot;
  delete rest.eventRatesSnapshot;
  return rest as RebookSource['result'];
}

export function buildRebookInsert(src: RebookSource): Record<string, unknown> {
  return {
    customer_name: src.customer_name ?? 'Anonymous',
    customer_address: src.customer_address ?? '(no address)',
    customer_phone: src.customer_phone ?? null,
    customer_email: src.customer_email ?? null,
    highlevel_contact_id: src.highlevel_contact_id ?? null,
    status: 'draft',
    ...(src.service_type ? { service_type: src.service_type } : {}),
    inputs: src.inputs,
    result: stripRatesSnapshots(src.result),
    total: src.result?.total ?? 0,
    customer_id: src.customer_id ?? null,
    property_id: src.property_id ?? null,
    // W2-002: carry the source's test flag so a rebooked TEST quote stays a
    // TEST quote — otherwise it defaults to false (real) and pollutes the
    // dashboard/jobs/invoices/PO surfaces that trust is_test as the isolation
    // boundary (#93).
    is_test: src.is_test ?? false,
  };
}

// The columns the source-quote lookup selects (kept in one place so the query +
// the RebookSource shape stay in sync).
const SOURCE_COLUMNS =
  'id, customer_name, customer_address, customer_phone, customer_email, highlevel_contact_id, service_type, inputs, result, customer_id, property_id, is_test';

// Clone a customer's last APPROVED quote (+ its design) into a fresh draft.
// `propertyId` optionally scopes the source to one property (a customer with a
// home + a rental rebooks the right one). Returns the new quote id + the cloned
// design id (null when the source had no design). Returns null when there is no
// approved quote to rebook from, or Supabase isn't configured.
export async function rebookLastSeason(
  customerId: string,
  propertyId?: string | null,
): Promise<{ quoteId: string; designId: string | null } | null> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return null;

  // The most recent approved quote for this customer (optionally one property).
  // "Approved" (customer_approved_at set) = what they agreed to last season —
  // the design worth cloning.
  let query = sb
    .from('quotes')
    .select(SOURCE_COLUMNS)
    .eq('customer_id', customerId)
    .not('customer_approved_at', 'is', null)
    .order('customer_approved_at', { ascending: false })
    .limit(1);
  if (propertyId) query = query.eq('property_id', propertyId);

  const { data, error } = await query.maybeSingle();
  if (error) {
    console.error('rebookLastSeason (source) error:', error);
    return null;
  }
  if (!data) return null; // no approved quote to rebook from
  const src = data as RebookSource & { id: string };

  const insertRow = buildRebookInsert({
    ...src,
    // Honor an explicit property scope; otherwise keep the source's property.
    property_id: propertyId ?? src.property_id ?? null,
  });
  const ins = await sb.from('quotes').insert(insertRow).select('id').single();
  if (ins.error || !ins.data) {
    console.error('rebookLastSeason (insert) error:', ins.error);
    return null;
  }
  const newQuoteId = ins.data.id as string;

  // Clone the design (scene + base photo + satellite). Best-effort: a missing or
  // failed clone still yields a usable rebooked quote (staff can re-pull).
  let designId: string | null = null;
  try {
    const cloned = await cloneDesignToNewQuote(src.id, newQuoteId);
    designId = cloned?.id ?? null;
  } catch (err) {
    console.error('rebookLastSeason (design clone) failed:', err);
  }

  return { quoteId: newQuoteId, designId };
}
