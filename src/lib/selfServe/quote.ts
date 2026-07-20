// Self-serve draft enrichment (Phase A). The /api/estimate route saves an
// Anonymous draft quote at the moment the price is measured (so an abandoned
// visit still leaves staff a "someone quoted 123 Main St for $X" row). When the
// customer then submits their contact info, this links their real name/email/
// phone and the GHL contact/opportunity onto that same draft.
//
// A focused, direct update (service-role, RLS-bypassing) rather than routing
// through updateQuote() — updateQuote re-PRICES the row, which is wrong here:
// enrichment must never move the money, only attach who the customer is.

import { getSupabaseServiceClient } from '@/lib/supabase';

export type SelfServeContact = {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

function clean(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = v.trim();
  return t.length ? t : null;
}

/**
 * Attach contact info + GHL ids to an existing self-serve draft quote. Best-
 * effort and fully non-throwing: the draft row is already saved (source of
 * truth), so a failure here is logged and reported via the boolean, never
 * surfaced to the customer. Only writes fields that were actually provided — a
 * null name leaves the row's existing customer_name (the 'Anonymous' default)
 * intact rather than blanking it.
 *
 * SECURITY: `quoteId` comes straight from a PUBLIC request body, so before
 * touching the row we verify it is actually a SELF-SERVE DRAFT (status 'draft'
 * AND inputs.meta.source === 'self_serve_estimate'). Without this, anyone
 * holding a quote UUID (it's the portal capability token, visible in customer
 * portal URLs) could overwrite the customer_name/email/phone + GHL link on a
 * staff-built quote for a real paying customer. A non-self-serve or non-draft
 * id is refused (returns false), never mutated.
 */
export async function enrichSelfServeQuote(
  quoteId: string,
  contact: SelfServeContact,
  ghl?: { contactId?: string | null; opportunityId?: string | null },
): Promise<boolean> {
  try {
    const supabase = getSupabaseServiceClient();
    if (!supabase) return false;

    const patch: Record<string, string> = {};
    const name = clean(contact.name);
    const email = clean(contact.email);
    const phone = clean(contact.phone);
    if (name) patch.customer_name = name;
    if (email) patch.customer_email = email;
    if (phone) patch.customer_phone = phone;
    const ghlContactId = clean(ghl?.contactId);
    const ghlOpportunityId = clean(ghl?.opportunityId);
    if (ghlContactId) patch.highlevel_contact_id = ghlContactId;
    if (ghlOpportunityId) patch.highlevel_opportunity_id = ghlOpportunityId;

    if (Object.keys(patch).length === 0) return true; // nothing to write

    // Ownership check: fetch the row and confirm it's a self-serve draft before
    // writing. (A jsonb-path filter on the UPDATE would be terser but harder to
    // read; the row is tiny and this path is low-frequency.)
    const { data: row, error: readErr } = await supabase
      .from('quotes')
      .select('status, inputs')
      .eq('id', quoteId)
      .maybeSingle<{ status: string | null; inputs: { meta?: { source?: string } } | null }>();
    if (readErr) {
      console.error('[selfServe] enrichSelfServeQuote read failed:', readErr.message);
      return false;
    }
    if (!row) return false; // unknown id
    const isSelfServeDraft = row.status === 'draft' && row.inputs?.meta?.source === 'self_serve_estimate';
    if (!isSelfServeDraft) {
      console.warn('[selfServe] enrichSelfServeQuote refused a non-self-serve-draft quote id');
      return false;
    }

    const { error } = await supabase.from('quotes').update(patch).eq('id', quoteId);
    if (error) {
      console.error('[selfServe] enrichSelfServeQuote update failed:', error.message);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[selfServe] enrichSelfServeQuote threw:', err instanceof Error ? err.name : 'error');
    return false;
  }
}
