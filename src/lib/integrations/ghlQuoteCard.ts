// Shared GHL card-move helper for the JOB routes (#GHL pipeline sync).
//
// Both /api/jobs/[id]/complete and /api/jobs/[id]/close independently run the
// to_schedule/scheduled → installed transition, so the "move the quote's GHL
// opportunity to the Installed stage" side effect lives here once and both
// routes call it at their respective transitions — otherwise a job closed
// directly via /close (without a prior /complete) would silently skip the move.
//
// Contract (identical to every other GHL call site in this feature):
//   - resolves the pipeline + Installed stage from the QUOTE's service_type
//     (resolvePipelineStages — holiday env override, permanent/event map);
//   - only MOVES an existing card (linked opportunity id, else a
//     findOpportunityForContact lookup) — never creates one here;
//   - skips a Test Quote (#93) and an unconfigured HighLevel entirely;
//   - FAIL-OPEN: never throws — any failure (including the quote read) is
//     caught and console.error'd, so job completion/close always succeeds
//     regardless of GHL's state.

import { getSupabaseServiceClient } from '@/lib/supabase';
import {
  updateOpportunity,
  findOpportunityForContact,
  isHighLevelConfigured,
  HighLevelError,
} from '@/lib/integrations/highlevel';
import { resolvePipelineStages } from '@/lib/integrations/ghlPipelineMap';

function hlErrorMessage(err: unknown): string {
  return err instanceof HighLevelError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Unknown HighLevel error';
}

type QuoteGhlRow = {
  id: string;
  highlevel_contact_id: string | null;
  highlevel_opportunity_id: string | null;
  service_type: string | null;
  is_test: boolean;
  // Legacy rebook (#156): routes to the Neighbors pipeline instead of the
  // service_type's own map — see resolvePipelineStages.
  legacy_rebook: boolean;
};

/**
 * Best-effort: once a job FIRST transitions to `installed`, move its quote's
 * GHL opportunity card to the Installed stage for the quote's service type.
 * Safe to call with a null quoteId (no-op). Never throws.
 */
export async function moveQuoteCardToInstalled(quoteId: string | null): Promise<void> {
  if (!quoteId) return;
  try {
    const sb = getSupabaseServiceClient();
    if (!sb) return;
    const { data: quote } = await sb
      .from('quotes')
      .select('id, highlevel_contact_id, highlevel_opportunity_id, service_type, is_test, legacy_rebook')
      .eq('id', quoteId)
      .maybeSingle<QuoteGhlRow>();
    if (!quote || quote.is_test || !isHighLevelConfigured()) return;
    const stages = resolvePipelineStages(quote.service_type, { legacyRebook: quote.legacy_rebook });
    let opportunityId = quote.highlevel_opportunity_id;
    if (!opportunityId && quote.highlevel_contact_id) {
      const existing = await findOpportunityForContact(quote.highlevel_contact_id, stages.pipelineId);
      opportunityId = existing?.id ?? null;
    }
    if (!opportunityId) return; // no card to move — never create one here
    await updateOpportunity(opportunityId, { pipelineStageId: stages.installed });
  } catch (err) {
    console.error(
      `[ghlQuoteCard] GHL installed stage move failed for quote ${quoteId}:`,
      hlErrorMessage(err),
    );
  }
}
