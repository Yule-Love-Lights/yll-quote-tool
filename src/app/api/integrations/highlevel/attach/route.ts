// Link a quote to a HighLevel contact's existing pipeline opportunity.
// Called from the admin UI right after saveQuote succeeds when the
// operator picked a contact from the HighLevel autocomplete.
//
// Semantics: LOOKUP FIRST. Customers typically exist in HighLevel before
// opening the quote tool — they were captured via a lead form and placed
// at the entry stage of their service line's pipeline (e.g. "📭Open" in
// Christmas Lights). We find that card and attach our quote to it (no
// duplicate). If (rare) the contact has no opportunity in the pipeline yet,
// we create one at the ENTRY stage — e.g. 📭Open / Open / New Lead, never an
// internal stage like "Make Quote".
//
// Pipeline resolution (#GHL pipeline sync): the pipeline + entry stage come
// from resolvePipelineStages(quote.service_type) — holiday still honors the
// legacy HIGHLEVEL_PIPELINE_ID / HIGHLEVEL_STAGE_QUOTE_CREATED env vars when
// set; permanent/event always use their own pipeline from the map. This route
// is where the map's `entry` stage is consumed (the send route deliberately
// creates missing cards at `sent`, per its own documented contract).
//
// POST /api/integrations/highlevel/attach
// Body:
//   {
//     quoteId: string       (UUID from our quotes table)
//     contactId: string     (HighLevel contact id from autocomplete pick)
//     opportunityName?: string  (used only if we have to create — e.g., "Holiday Lights — 123 Main St")
//     monetaryValue?: number    (quote total, used as deal value if we create)
//   }
// Response:
//   { opportunityId: string, created: boolean, linked: boolean }    — on success
//        (linked:false means the GHL card exists but the local quote row could
//         not be updated — retry is safe and re-attaches to the same open card)
//   { error: string, code?: string }               — on failure

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import {
  findOrCreateOpportunityForContact,
  isHighLevelConfigured,
  HighLevelError,
} from '@/lib/integrations/highlevel';
import { resolvePipelineStages } from '@/lib/integrations/ghlPipelineMap';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { requireOperator } from '@/lib/auth/supabaseServer';
import { attachQuoteToCustomer, quoteRowToIdentity } from '@/lib/customers';

export const runtime = 'nodejs';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  const denied = await requireOperator();
  if (denied) return denied;
  if (!isHighLevelConfigured()) {
    return NextResponse.json(
      { error: 'HighLevel not configured', code: 'highlevel-missing' },
      { status: 503 },
    );
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json(
      { error: 'Supabase service role not configured', code: 'supabase-missing' },
      { status: 503 },
    );
  }

  const rl = rateLimitResponse(req, { bucket: 'ghl-attach', limit: 20, windowMs: 60_000 });
  if (rl) return rl;

  let body: {
    quoteId?: string;
    contactId?: string;
    opportunityName?: string;
    monetaryValue?: number;
    detach?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.quoteId || !UUID_RE.test(body.quoteId)) {
    return NextResponse.json({ error: 'quoteId must be a valid UUID' }, { status: 400 });
  }
  // #172: detach — the builder's Clear button must be a real undo (the
  // pick-time attach may already have linked the row, or still be in flight
  // behind the client's serialized queue). Clears the LOCAL link only; the
  // GHL card itself is untouched.
  if (body.detach === true) {
    const { error: detachErr } = await getSupabaseServiceClient()!
      .from('quotes')
      .update({ highlevel_contact_id: null, highlevel_opportunity_id: null })
      .eq('id', body.quoteId);
    if (detachErr) {
      return NextResponse.json({ error: `Detach failed: ${detachErr.message}` }, { status: 500 });
    }
    return NextResponse.json({ detached: true });
  }
  if (!body.contactId || typeof body.contactId !== 'string') {
    return NextResponse.json({ error: 'contactId required (HighLevel contact id)' }, { status: 400 });
  }

  const sb = getSupabaseServiceClient()!;

  // Which pipeline this quote's card belongs in (#GHL pipeline sync): resolve
  // from the quote's service_type. A read hiccup falls back to the holiday
  // default rather than blocking the attach (fail-open — same posture as the
  // other GHL call sites). The pipeline map always supplies ids, so the old
  // "env vars not set" 503 can only trip if resolution somehow yields blanks
  // (kept as a defensive guard with the same code/status as before).
  const { data: quoteRow, error: quoteErr } = await sb
    .from('quotes')
    // #214: is_test + the identity columns ride along for the post-link
    // customers re-resolution below (no second read).
    .select(
      'id, service_type, legacy_rebook, is_test, customer_name, customer_email, customer_phone, customer_address',
    )
    .eq('id', body.quoteId)
    .maybeSingle<{
      id: string;
      service_type: string | null;
      legacy_rebook: boolean;
      is_test: boolean;
      customer_name: string | null;
      customer_email: string | null;
      customer_phone: string | null;
      customer_address: string | null;
    }>();
  if (quoteErr) {
    console.warn(
      '[api/integrations/highlevel/attach] service_type read failed — defaulting to the holiday pipeline:',
      quoteErr.message,
    );
  }
  // Legacy rebook (#156): legacy_rebook wins regardless of service_type,
  // routing to the Neighbors pipeline instead of Christmas Lights — a staff
  // member manually attaching a migrated quote to a GHL contact must never
  // create/find its card in the regular holiday pipeline.
  const stages = resolvePipelineStages(quoteRow?.service_type, { legacyRebook: quoteRow?.legacy_rebook });
  if (!stages.pipelineId || !stages.entry) {
    return NextResponse.json(
      {
        error:
          'Could not resolve a HighLevel pipeline for this quote. Pipeline + stage ids come from the pipeline map (src/lib/integrations/ghlPipelineMap.ts); the HIGHLEVEL_PIPELINE_ID / HIGHLEVEL_STAGE_QUOTE_CREATED env vars only override the holiday entry.',
        code: 'pipeline-missing',
      },
      { status: 503 },
    );
  }

  try {
    // NOTE: this is where the map's `entry` stage is consumed — a contact with
    // no card yet gets one created at their pipeline's entry stage (📭Open /
    // Open / New Lead). The send route intentionally differs: it creates
    // missing cards directly at the `sent` stage, per its own contract.
    const { opportunity, created, resurrected } = await findOrCreateOpportunityForContact({
      contactId: body.contactId,
      pipelineId: stages.pipelineId,
      fallbackStageId: stages.entry,
      fallbackName: body.opportunityName?.trim() || `Holiday Lights quote ${body.quoteId.slice(0, 8)}`,
      monetaryValue:
        typeof body.monetaryValue === 'number' && body.monetaryValue > 0
          ? body.monetaryValue
          : undefined,
    });

    // Write-back: link the GHL IDs onto our quote row. If this fails we
    // still return 200 — the opportunity exists on GHL's side, we just
    // lost the local link. We report `linked:false` so the operator UI can
    // surface "card created but not linked — retry safe" (a retry re-finds the
    // same open card and re-attaches, so no hard 500 is needed).
    const { error: updateErr } = await sb
      .from('quotes')
      .update({
        highlevel_contact_id: body.contactId,
        highlevel_opportunity_id: opportunity.id,
      })
      .eq('id', body.quoteId);
    if (updateErr) {
      // Audit fix (#53): escalate warn → error and include quoteId + opportunity.id
      // so the orphaned GHL card (exists remotely, unlinked locally) is discoverable.
      console.error(
        '[api/integrations/highlevel/attach] DB link failed — orphaned GHL card:',
        { quoteId: body.quoteId, opportunityId: opportunity.id, error: updateErr.message },
      );
    }

    // #214 (d): this route is where a quote GAINS its hl contact id after
    // insert — and, pre-#214, nothing downstream ever re-ran the customers
    // resolution with it. A quote linked to an hl-less customers row stayed
    // hl-less forever (the #700 heal lives INSIDE attachQuoteToCustomer, so
    // it never fired), and the #213 hl-agree/veto rules never saw the pick.
    // Re-resolve now, with the quote's stored identity + the JUST-picked
    // contact id: an hl-less linked row gets the heal stamp; an identity
    // that #213-classifies onto a different row RELINKS the quote (the pick
    // is the operator saying "this person" — the customers link should
    // follow it). Gated !is_test (attachQuoteToCustomer must never run with
    // test data) and skipped when the pre-link read failed (quoteRow null —
    // no identity to resolve with; the next save/send re-attach covers it).
    // Best-effort: never changes this route's response.
    if (!updateErr && quoteRow && !quoteRow.is_test) {
      try {
        await attachQuoteToCustomer(
          quoteRowToIdentity({
            id: body.quoteId,
            highlevel_contact_id: body.contactId,
            customer_name: quoteRow.customer_name,
            customer_email: quoteRow.customer_email,
            customer_phone: quoteRow.customer_phone,
            customer_address: quoteRow.customer_address,
          }),
        );
      } catch (err) {
        console.warn(
          '[api/integrations/highlevel/attach] customers re-resolution failed (non-fatal):',
          err,
        );
      }
    }

    return NextResponse.json({
      opportunityId: opportunity.id,
      created,
      // #172: surfaced so a surprising board change (an old card reopened) is
      // visible in the response, not just the server log.
      resurrected: resurrected ?? false,
      linked: !updateErr,
    });
  } catch (err) {
    console.error('[api/integrations/highlevel/attach] failed:', err);
    if (err instanceof HighLevelError) {
      return NextResponse.json(
        { error: err.message, code: 'highlevel-error' },
        { status: err.status && err.status >= 400 && err.status < 600 ? err.status : 502 },
      );
    }
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
