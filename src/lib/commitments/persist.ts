// Finalizes extracted commitments in one atomic RPC
// (calls_merge_plan_2026-08.md slice S6). Faithful port of the
// yll-call-copilot repo's src/lib/commitments/persist.ts (master fb1bf326)
// -- see that file's own comment history for the full #217 review record
// behind call_commitments_finalize_extraction's design (a first fix did the
// check-then-write as two application round trips with a TOCTOU gap; the
// current function closes that gap by doing both inside one locked
// transaction). Only the source table changed: this repo's finalize
// function (migrations/2026-08-29-call-commitments.sql) reads/writes
// call_transcripts, not transcripts, and has no metric_scope check (no
// verticals system exists here yet).
//
// DEVIATION from the copilot: that function's FINAL form (migration 0024,
// which this repo ports) replaces the whole open set with DELETE + INSERT,
// not an ON CONFLICT upsert (0022's earlier, superseded design) -- see the
// migration file's own header for why. This wrapper's contract is
// unaffected either way; it only calls the RPC and interprets its result.
//
// REP ASSIGNMENT (same-day ruling): the finalize RPC now takes a 4th param,
// p_assigned_to -- the operator id every commitment-derived task from this
// transcript should be assigned to (or null, unresolved). The MAPPING
// itself (rep email -> operator account) happens in the caller
// (backfill.ts), via src/lib/auth/adminUsers.ts's findOperatorByEmail --
// this function only forwards an already-resolved id, it does no lookup.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CommitmentRow } from './types';

export type PersistResult =
  | { ok: true; alreadyFinalized: boolean }
  | { ok: false; reason: 'has_resolved_commitments' };

export async function persistCommitments(
  supabase: SupabaseClient,
  transcriptId: string,
  repEmail: string | null,
  ghlContactId: string | null,
  commitments: CommitmentRow[],
  extractorVersion: string,
  assignedTo: string | null,
): Promise<PersistResult> {
  // status/dismissed_reason/verified_by_event/cleared_at are deliberately
  // absent -- the finalizer refuses any transcript with a resolved row and
  // replaces only a wholly open pre-marker set.
  const { data, error } = await supabase.rpc('call_commitments_finalize_extraction', {
    p_transcript_id: transcriptId,
    p_rows: commitments.map(c => ({
      ghl_contact_id: ghlContactId,
      rep_email: repEmail,
      kind: c.kind,
      detail: c.detail,
      promised_at: c.promised_at,
      extraction_index: c.extraction_index,
    })),
    p_extractor_version: extractorVersion,
    p_assigned_to: assignedTo,
  });
  if (error) throw error;

  if (data === 'refused') {
    console.warn(
      `Refused re-extraction for transcript ${transcriptId}: it already has a resolved (non-'open') commitment; a reordered re-extraction could mislabel it.`,
    );
    return { ok: false, reason: 'has_resolved_commitments' };
  }
  if (data !== 'ok' && data !== 'already_finalized') {
    throw new Error(`Unexpected commitment finalizer result: ${String(data)}`);
  }
  return { ok: true, alreadyFinalized: data === 'already_finalized' };
}
