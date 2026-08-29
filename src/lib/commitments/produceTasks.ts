// THE PRODUCER's TypeScript side (calls_merge_plan_2026-08.md slice S6): once
// a transcript's commitments are freshly finalized (persistCommitments
// returned ok && !alreadyFinalized), reads back its OPEN commitments and
// turns each into an office_tasks row via the office_tasks_create_from_
// commitment RPC (migrations/2026-08-29-call-commitments.sql). NEW code, not
// a copilot port -- the copilot never built this producer (see the merge
// plan's S6 paragraph).
//
// Best-effort per commitment, mirroring src/lib/calls/pipeline.ts's
// per-recording isolation: one commitment's RPC failure is logged and the
// loop moves on, never aborting the whole batch. The RPC itself is
// idempotent (office_tasks' (source_system, source_event_id) unique index),
// so calling this twice for the same transcript is safe -- a second pass
// creates zero new tasks.

import type { SupabaseClient } from '@supabase/supabase-js';

export type ProduceTasksResult = { attempted: number; created: number };

export async function produceOfficeTasksFromCommitments(
  supabase: SupabaseClient,
  transcriptId: string,
): Promise<ProduceTasksResult> {
  const { data, error } = await supabase
    .from('call_commitments')
    .select('id')
    .eq('transcript_id', transcriptId)
    .eq('status', 'open');
  if (error) throw error;

  const ids = ((data ?? []) as { id: string }[]).map(row => row.id);
  let created = 0;
  for (const id of ids) {
    const { data: taskId, error: rpcError } = await supabase.rpc('office_tasks_create_from_commitment', {
      p_commitment_id: id,
    });
    if (rpcError) {
      console.error(`Failed to create an office task for commitment ${id}:`, rpcError);
      continue;
    }
    if (taskId) created++;
  }
  return { attempted: ids.length, created };
}
