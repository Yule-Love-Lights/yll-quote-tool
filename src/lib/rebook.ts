import { getSupabaseClient, getSupabaseServiceClient } from './supabase';
import { cloneDesignToNewQuote } from './designs';
import { allocateNumber } from './displayId';
import { getCustomer, unarchiveProperty } from './customers';

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
  // NCE + YLL Neighbor tags (#198): the SOURCE quote's own tags — carried
  // forward as a plain clone-field default (like is_test above). rebookLastSeason
  // overrides these with the CUSTOMER's current tags before calling
  // buildRebookInsert (a customer may have been tagged more recently than
  // their last approved quote); rebookFromQuote (#116 exact-quote revive)
  // leaves them as-is, so a revived quote simply keeps its own tags.
  legacy_rebook?: boolean | null;
  is_nce?: boolean | null;
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
  delete rest.permanentBistroRatesSnapshot;
  return rest as RebookSource['result'];
}

// #41 adversarial-review HIGH fix: a rebooked quote must RE-EARN and
// RE-APPLY its own referral credit next season, never inherit the source
// quote's. Without this, cloning an approved quote that had a referral
// credit applied would carry the `discount` + `referralCredit` provenance
// straight onto the new DRAFT — which still shows "credit applied" even
// though this new quote's credited rows/consumedRowIds belong to the OLD
// quote entirely. Mirrors stripRatesSnapshots's shallow-copy-and-delete.
function stripDiscountAndReferralCredit(inputs: unknown): unknown {
  if (!inputs || typeof inputs !== 'object') return inputs;
  const rest = { ...(inputs as Record<string, unknown>) };
  delete rest.discount;
  delete rest.referralCredit;
  return rest;
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
    inputs: stripDiscountAndReferralCredit(src.inputs),
    result: stripRatesSnapshots(src.result),
    total: src.result?.total ?? 0,
    customer_id: src.customer_id ?? null,
    property_id: src.property_id ?? null,
    // W2-002: carry the source's test flag so a rebooked TEST quote stays a
    // TEST quote — otherwise it defaults to false (real) and pollutes the
    // dashboard/jobs/invoices/PO surfaces that trust is_test as the isolation
    // boundary (#93).
    is_test: src.is_test ?? false,
    // NCE + YLL Neighbor tags (#198) — see the RebookSource field comments
    // above for which value each caller passes in.
    legacy_rebook: src.legacy_rebook ?? false,
    is_nce: src.is_nce ?? false,
  };
}

// The columns the source-quote lookup selects (kept in one place so the query +
// the RebookSource shape stay in sync).
const SOURCE_COLUMNS =
  'id, customer_name, customer_address, customer_phone, customer_email, highlevel_contact_id, service_type, inputs, result, customer_id, property_id, is_test, legacy_rebook, is_nce';

// Best-effort sequential quote_number (ledger #83, SPEC §4.6) for a rebooked
// clone — same allocateNumber('quote_number_seq') + try/catch-omit pattern
// saveQuote uses. A failed allocation (RPC/sequence missing) must NOT block
// the rebook; the column is nullable and the truncated-UUID display (#77)
// still works. Without this, rebooked quotes silently skip the sequence and
// are missed by any number search/sort.
async function allocateRebookQuoteNumber(caller: string): Promise<number | null> {
  try {
    return await allocateNumber('quote_number_seq');
  } catch (err) {
    console.warn(`${caller}: quote_number allocation skipped:`, err);
    return null;
  }
}

// #205 review fix (customer/staff HIGH, F1 — "related, same root"): a
// rebook that resolves onto an ARCHIVED property resurrects it. Both
// rebookLastSeason and rebookFromQuote below insert the new quote via a
// raw `.from('quotes').insert()` that bypasses findOrCreateProperty
// entirely — the function that normally carries the archive-resurrection
// rule (see its own #205 comment in customers.ts) — so without this, a
// rebook could silently point a brand-new LIVE draft at a property staff
// had archived: exactly the "silently-hidden-but-active" state that rule
// exists to prevent, reached through a different door.
//
// Read-then-write (not an unconditional unarchiveProperty call) so this
// only writes — and only logs — when a resurrection is ACTUALLY happening;
// rebooking onto an already-live property stays a no-op, same "no needless
// write" discipline as findOrCreateProperty's own resurrection branch.
//
// Best-effort: a failure here must never block the rebook itself (mirrors
// attachQuoteToCustomer's hl_contact_id heal in customers.ts).
async function resurrectPropertyForRebook(
  sb: NonNullable<ReturnType<typeof getSupabaseServiceClient>>,
  customerId: string | null | undefined,
  propertyId: string | null | undefined,
  caller: string,
): Promise<void> {
  if (!customerId || !propertyId) return;
  try {
    const { data: propRow } = await sb
      .from('properties')
      .select('archived_at')
      .eq('id', propertyId)
      .eq('customer_id', customerId)
      .maybeSingle<{ archived_at: string | null }>();
    if (!propRow?.archived_at) return; // already live, or no such row — nothing to do
    const { error } = await unarchiveProperty(customerId, propertyId);
    if (error) {
      console.warn(`${caller}: resurrect-on-rebook failed for property ${propertyId} (customer ${customerId}):`, error);
    } else {
      console.info(`${caller}: un-archived property ${propertyId} for customer ${customerId} (triggered by rebook)`);
    }
  } catch (err) {
    console.warn(`${caller}: resurrect-on-rebook threw for property ${propertyId} (customer ${customerId}):`, err);
  }
}

// Clone a customer's last APPROVED quote (+ its design) into a fresh draft.
// `propertyId` optionally scopes the source to one property (a customer with a
// home + a rental rebooks the right one). Returns the new quote id + the cloned
// design id (null when the source had no design). Returns null when there is no
// approved quote to rebook from, or Supabase isn't configured.
export async function rebookLastSeason(
  customerId: string,
  propertyId?: string | null,
  // Actor audit trail (#90): the operator's Supabase user id, or null when the
  // auth gate is dormant (no session) / the caller doesn't have one. Same
  // convention as saveQuote's createdBy param.
  createdBy: string | null = null,
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

  // NCE + YLL Neighbor tags (#198): inherit the CUSTOMER's CURRENT tags
  // (customer→quote inheritance), not necessarily whatever this particular
  // old approved quote happened to carry — the customer may have been tagged
  // more recently (profile edit, or propagation off a later quote) than their
  // last approved one. Best-effort: getCustomer fails soft (null on error /
  // unconfigured), which falls back to the source quote's own tag below.
  const customer = await getCustomer(customerId);

  const quoteNumber = await allocateRebookQuoteNumber('rebookLastSeason');
  // Honor an explicit property scope; otherwise keep the source's property.
  const targetPropertyId = propertyId ?? src.property_id ?? null;
  // #205 F1: resurrect if the target is archived — see resurrectPropertyForRebook.
  await resurrectPropertyForRebook(sb, customerId, targetPropertyId, 'rebookLastSeason');
  const insertRow = {
    ...buildRebookInsert({
      ...src,
      property_id: targetPropertyId,
      legacy_rebook: customer?.is_yll_neighbor ?? src.legacy_rebook ?? false,
      is_nce: customer?.is_nce ?? src.is_nce ?? false,
    }),
    ...(quoteNumber != null ? { quote_number: quoteNumber } : {}),
    created_by: createdBy,
  };
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

// Clone a SPECIFIC quote (by id, any status) into a fresh draft — the #116
// "revive a dead quote" path. Unlike rebookLastSeason (which finds a customer's
// last APPROVED quote), this reopens exactly the quote the operator picked,
// including a declined / cancelled / lost one, and leaves the original terminal
// quote INTACT for the audit trail. Reuses buildRebookInsert (strips the
// lifecycle + the frozen rate snapshots so the draft re-prices at live rates)
// and cloneDesignToNewQuote. Returns the new quote id + the cloned design id
// (null when the source had no design), or null when the id doesn't match a
// quote or Supabase isn't configured.
export async function rebookFromQuote(
  quoteId: string,
  // Actor audit trail (#90): the operator's Supabase user id, or null when the
  // auth gate is dormant (no session) / the caller doesn't have one. Same
  // convention as saveQuote's createdBy param.
  createdBy: string | null = null,
): Promise<{ quoteId: string; designId: string | null } | null> {
  const sb = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!sb) return null;

  const { data, error } = await sb
    .from('quotes')
    .select(SOURCE_COLUMNS)
    .eq('id', quoteId)
    .maybeSingle();
  if (error) {
    console.error('rebookFromQuote (source) error:', error);
    return null;
  }
  if (!data) return null; // no such quote to rebook from
  const src = data as RebookSource & { id: string };

  const quoteNumber = await allocateRebookQuoteNumber('rebookFromQuote');
  // #205 F1: resurrect if the source's property is archived — same rule as
  // rebookLastSeason above; rebookFromQuote always carries src.property_id
  // through unchanged (no property-scope override param), so that's the
  // one target to check here.
  await resurrectPropertyForRebook(sb, src.customer_id, src.property_id, 'rebookFromQuote');
  const insertRow = {
    ...buildRebookInsert(src),
    ...(quoteNumber != null ? { quote_number: quoteNumber } : {}),
    created_by: createdBy,
  };
  const ins = await sb.from('quotes').insert(insertRow).select('id').single();
  if (ins.error || !ins.data) {
    console.error('rebookFromQuote (insert) error:', ins.error);
    return null;
  }
  const newQuoteId = ins.data.id as string;

  // Clone the design (scene + base photo + satellite). Best-effort, same as
  // rebookLastSeason: a missing or failed clone still yields a usable draft.
  let designId: string | null = null;
  try {
    const cloned = await cloneDesignToNewQuote(src.id, newQuoteId);
    designId = cloned?.id ?? null;
  } catch (err) {
    console.error('rebookFromQuote (design clone) failed:', err);
  }

  return { quoteId: newQuoteId, designId };
}
