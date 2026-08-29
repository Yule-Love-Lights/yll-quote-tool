// Reports how many office_tasks rows exist for a transcript's commitments
// (calls_merge_plan_2026-08.md slice S6).
//
// REPURPOSED by the fix round: THE PRODUCER itself now runs INSIDE
// call_commitments_finalize_extraction's own transaction
// (migrations/2026-08-29-call-commitments.sql) -- folding task creation
// into the SAME atomic write as the commitment rows eliminates a
// two-round-trip orphan window a technical-lens review found (a crash
// between "commitments finalized" and "tasks produced" could leave an
// open commitment with no task forever, since a finalized transcript is
// never re-selected for extraction). See that migration file's header for
// the full reasoning.
//
// This module is now READ-ONLY: it counts the office_tasks rows finalize
// already created, purely so backfillCommitments can report an honest
// tasksCreated number back to its caller (the /admin/calls "Extract
// commitments" button and the cron). It creates nothing itself, so it
// cannot introduce a NEW orphan risk if it fails -- a caught read failure
// just means that one transcript's count is reported as 0 for this batch,
// logged, and the batch continues; the tasks themselves already exist
// (finalize already committed them) whether or not this count-read
// succeeds.

import type { SupabaseClient } from '@supabase/supabase-js';

export async function countOfficeTasksForTranscript(
  supabase: SupabaseClient,
  transcriptId: string,
): Promise<number> {
  const { data: commitmentRows, error: commitmentError } = await supabase
    .from('call_commitments')
    .select('id')
    .eq('transcript_id', transcriptId);
  if (commitmentError) throw commitmentError;

  const ids = ((commitmentRows ?? []) as { id: string }[]).map(row => row.id);
  if (ids.length === 0) return 0;

  const { count, error: countError } = await supabase
    .from('office_tasks')
    .select('id', { count: 'exact', head: true })
    .eq('source_system', 'call_commitment')
    .in('source_event_id', ids);
  if (countError) throw countError;
  return count ?? 0;
}
