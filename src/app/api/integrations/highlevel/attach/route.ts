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
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.quoteId || !UUID_RE.test(body.quoteId)) {
    return NextResponse.json({ error: 'quoteId must be a valid UUID' }, { status: 400 });
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
    .select('id, service_type')
    .eq('id', body.quoteId)
    .maybeSingle<{ id: string; service_type: string | null }>();
  if (quoteErr) {
    console.warn(
      '[api/integrations/highlevel/attach] service_type read failed — defaulting to the holiday pipeline:',
      quoteErr.message,
    );
  }
  const stages = resolvePipelineStages(quoteRow?.service_type);
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
    const { opportunity, created } = await findOrCreateOpportunityForContact({
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

    return NextResponse.json({ opportunityId: opportunity.id, created, linked: !updateErr });
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
