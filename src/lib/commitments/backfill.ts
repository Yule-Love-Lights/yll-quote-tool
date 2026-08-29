// Batch-capable entry point processing call_transcripts through the
// commitment extractor (calls_merge_plan_2026-08.md slice S6). Shared by
// the on-demand admin route (POST /api/calls/extract) and the cron (GET
// /api/cron/calls-extract) -- same shape as src/lib/calls/pipeline.ts's
// processPendingRecordings. Ported from the yll-call-copilot repo's
// src/lib/commitments/backfill.ts (master fb1bf326), adapted:
//   - Reads call_transcripts, not transcripts; drops every metric_scope
//     filter/column (no verticals system exists here yet -- S3 is unbuilt).
//   - Drops the verticalName parameter (extractRawCommitments no longer
//     takes one -- see extract.ts's header).
//
// FIX ROUND (technical-lens finding, same day): THE PRODUCER used to run
// here as a SEPARATE round trip after persistCommitments/finalize
// succeeded -- a crash or transient failure between the two could orphan
// an open commitment with no task forever, since backfillCommitments's own
// candidate queries permanently exclude any transcript once
// commitments_extracted_at is set. Fixed by folding task production INTO
// call_commitments_finalize_extraction's own transaction
// (migrations/2026-08-29-call-commitments.sql) -- either the commitments
// AND their tasks commit together, or neither does. This file no longer
// calls the producer at all; after a FRESH finalize (ok && not
// alreadyFinalized) it only READS how many tasks already exist for that
// transcript (countOfficeTasksForTranscript, produceTasks.ts, repurposed
// into a reporting-only helper) so the batch result can still report an
// honest tasksCreated count. A failure of that READ is caught and logged,
// never thrown -- the tasks themselves already exist regardless of whether
// this count succeeds.
//
// The transcript-level completion markers (call_transcripts.
// commitments_extracted_at etc., added by S2's migration) are required even
// when extraction finds zero commitments, and the database filters them
// before applying the batch limit so an older transcript cannot be hidden
// forever behind a full window of already-processed recent rows.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  extractRawCommitments,
  EXTRACT_MODEL,
  isTerminalCommitmentExtractionError,
} from './extract';
import { buildCommitmentRows } from './build';
import { persistCommitments } from './persist';
import { countOfficeTasksForTranscript } from './produceTasks';

// Batch cap only. The database filters durable extraction markers BEFORE
// applying this bound, so processed recent transcripts cannot hide older work.
const CANDIDATE_WINDOW = 200;

// How many transcripts a single cron/on-demand invocation extracts. Shared
// so "extract the next batch" means the same thing whether it's the cron or
// the admin page's button (mirrors RECORDING_BATCH_SIZE in src/lib/calls/sync.ts).
export const COMMITMENT_EXTRACTION_BATCH_SIZE = 6;

export type BackfillCandidate = {
  id: string;
  raw_text: string;
  called_at: string | null;
  commitment_extraction_last_attempt_at: string | null;
  rep_email: string | null;
  ghl_contact_id: string | null;
};

export type BackfillResult = {
  done: number;
  skipped: number;
  failed: number;
  refused: number;
  quarantined: number;
  tasksCreated: number;
};

// Pure selection helper retained for callers/tests that already have a set of
// completed ids. The normal database path has filtered durable markers first.
export function selectBackfillCandidates(
  candidates: BackfillCandidate[],
  alreadyExtractedIds: ReadonlySet<string>,
  limit: number,
): BackfillCandidate[] {
  const eligible = candidates.filter(c => !alreadyExtractedIds.has(c.id));
  const byCallTime = (left: BackfillCandidate, right: BackfillCandidate) =>
    (left.called_at ?? '').localeCompare(right.called_at ?? '') || left.id.localeCompare(right.id);
  const fresh = eligible
    .filter(candidate => candidate.commitment_extraction_last_attempt_at === null)
    .sort(byCallTime);
  const retries = eligible
    .filter(candidate => candidate.commitment_extraction_last_attempt_at !== null)
    .sort((left, right) =>
      left.commitment_extraction_last_attempt_at!.localeCompare(
        right.commitment_extraction_last_attempt_at!,
      ) || byCallTime(left, right));

  // Reserve one slot for the oldest retry whenever one exists. New calls
  // therefore keep moving while a deterministic failure still reaches its
  // bounded third-attempt quarantine under steady transcript intake.
  const retrySlots = retries.length > 0 && limit > 0 ? 1 : 0;
  return [
    ...fresh.slice(0, Math.max(0, limit - retrySlots)),
    ...retries.slice(0, retrySlots),
  ];
}

export async function backfillCommitments(
  supabase: SupabaseClient,
  limit: number,
): Promise<BackfillResult> {
  const batchLimit = Math.max(1, Math.min(limit, CANDIDATE_WINDOW));
  const selectColumns = 'id, raw_text, called_at, commitment_extraction_last_attempt_at, rep_email, ghl_contact_id';
  const retryQuery = supabase
    .from('call_transcripts')
    .select(selectColumns)
    .is('commitments_extracted_at', null)
    .is('commitment_extraction_quarantined_at', null)
    .not('commitment_extraction_last_attempt_at', 'is', null)
    .order('commitment_extraction_last_attempt_at', { ascending: true })
    .order('called_at', { ascending: true, nullsFirst: true })
    .order('id', { ascending: true })
    .limit(1);
  const { data: retryRows, error: retryError } = await retryQuery;
  if (retryError) throw retryError;

  const retryCandidates = (retryRows ?? []) as BackfillCandidate[];
  const freshLimit = Math.max(0, batchLimit - Math.min(1, retryCandidates.length));
  let freshRows: BackfillCandidate[] = [];
  if (freshLimit > 0) {
    const { data, error } = await supabase
      .from('call_transcripts')
      .select(selectColumns)
      .is('commitments_extracted_at', null)
      .is('commitment_extraction_quarantined_at', null)
      .is('commitment_extraction_last_attempt_at', null)
      .order('called_at', { ascending: true, nullsFirst: true })
      .order('id', { ascending: true })
      .limit(freshLimit);
    if (error) throw error;
    freshRows = (data ?? []) as BackfillCandidate[];
  }
  const candidates = [...freshRows, ...retryCandidates];
  if (candidates.length === 0) {
    return { done: 0, skipped: 0, failed: 0, refused: 0, quarantined: 0, tasksCreated: 0 };
  }

  const selected = selectBackfillCandidates(candidates, new Set(), limit);
  if (selected.length === 0) {
    return { done: 0, skipped: 0, failed: 0, refused: 0, quarantined: 0, tasksCreated: 0 };
  }

  let done = 0;
  let skipped = 0;
  let failed = 0;
  let refused = 0;
  let quarantined = 0;
  let tasksCreated = 0;
  for (const t of selected) {
    try {
      const raw = await extractRawCommitments(t.raw_text);
      const rows = buildCommitmentRows(raw, t.called_at);
      // A transcript can reach this branch with preexisting rows if a prior
      // process wrote commitments but crashed before writing the completion
      // marker. Persist remains idempotent for open rows and refuses resolved
      // rows; either outcome is then marked so it cannot starve older work.
      const result = await persistCommitments(
        supabase,
        t.id,
        t.rep_email,
        t.ghl_contact_id,
        rows,
        EXTRACT_MODEL,
      );
      if (result.ok) {
        if (result.alreadyFinalized) {
          skipped++;
        } else {
          done++;
          // THE PRODUCER already ran, atomically, inside finalize's own
          // transaction (migrations/2026-08-29-call-commitments.sql) -- this
          // is a read-only count for reporting only, not what creates the
          // tasks. A count failure is logged and swallowed: the tasks
          // themselves already exist regardless.
          try {
            tasksCreated += await countOfficeTasksForTranscript(supabase, t.id);
          } catch (err) {
            console.error(`Failed to count office tasks for transcript ${t.id}:`, err);
          }
        }
      } else {
        refused++;
      }
    } catch (err) {
      console.error(`Failed to extract commitments for transcript ${t.id}:`, err);
      const failureCode = isTerminalCommitmentExtractionError(err)
        ? 'deterministic_extraction_failed'
        : 'transient_dependency_failed';
      const { data: failureState, error: failureStateError } = await supabase.rpc(
        'record_commitment_extraction_failure',
        { p_transcript_id: t.id, p_failure_code: failureCode },
      );
      if (failureStateError) throw failureStateError;
      if (
        failureState !== 'retry_scheduled'
        && failureState !== 'quarantined'
        && failureState !== 'already_finalized'
        && failureState !== 'already_quarantined'
      ) {
        throw new Error(`Unexpected commitment failure-state result: ${String(failureState)}`);
      }
      if (failureState === 'already_finalized') {
        skipped++;
        continue;
      }
      if (failureState === 'quarantined' || failureState === 'already_quarantined') {
        quarantined++;
      }
      failed++;
    }
  }

  return { done, skipped, failed, refused, quarantined, tasksCreated };
}
