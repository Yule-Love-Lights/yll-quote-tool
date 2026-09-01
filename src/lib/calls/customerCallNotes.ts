// Reads a customer's call summaries + follow-up tasks for the
// /customers/[contactId] profile page (Naldo's ask, 2026-08-30). This is
// the SAME content that goes into the HighLevel note and internal comment
// (composeCallNote in noteBody.ts), read back out for our own staff view,
// so a rep never has to leave the quote tool to see what a call was about.
//
// Deliberately does NOT read raw_text: the summary and the extracted tasks
// are what a rep needs, and the full transcript is a much heavier read for
// a page that renders on every profile visit.
//
// Voicemails are included on purpose (Naldo's call, 2026-08-30, extending
// the same ruling made for the HighLevel note) — do not filter them here.
//
// FIX ROUND (staff-lens HIGH): a call's commitments are the SOURCE of an
// office_tasks row (produceTasks.ts / call_commitments_finalize_extraction),
// linked by office_tasks.source_event_id = call_commitments.id. The first
// cut of this panel read call_commitments directly and showed every task as
// a bare bullet forever, even after a rep marked it Completed on the real
// Tasks page — this reads the live office_tasks status through that link
// instead, so a done or dismissed task reads as done or dismissed here too.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServiceClient, getSupabaseClient } from '../supabase';
import { isCallNotesSchemaUnavailable } from './errors';
import type { OfficeTaskStatus } from '../officeTasks';

export type CustomerCallTask = {
  detail: string;
  promisedAt: string | null;
  // Null only if no office_tasks row exists for this commitment at all (a
  // finalize/produce mismatch this repo's own migration comments say should
  // not happen, but the read degrades to treating it as still open rather
  // than throwing over one missing row).
  status: OfficeTaskStatus | null;
};

// The note-posting state for one call, distinguished for the reader (a
// staff-lens MED: 'pending' and 'quarantined' both read ghl_note_posted_at
// as null, and conflating them made a permanently failed call look
// identical to one still waiting on the calls-note cron).
export type CustomerCallNoteStatus = 'posted' | 'quarantined' | 'pending';

export type CustomerCallNote = {
  transcriptId: string;
  calledAt: string | null;
  summary: string;
  noteStatus: CustomerCallNoteStatus;
  tasks: CustomerCallTask[];
};

// How many recent calls the panel shows. A customer profile page renders
// on every visit; unbounded history for a long-tenure customer would make
// this the heaviest query on the page for no reader benefit.
const MAX_CALLS = 20;

type TranscriptRow = {
  id: string;
  called_at: string | null;
  summary: string | null;
  ghl_note_posted_at: string | null;
  ghl_note_quarantined_at: string | null;
};

type CommitmentRow = {
  id: string;
  transcript_id: string;
  detail: string;
  promised_at: string | null;
};

type OfficeTaskRow = {
  source_event_id: string;
  status: OfficeTaskStatus;
};

function noteStatusOf(t: Pick<TranscriptRow, 'ghl_note_posted_at' | 'ghl_note_quarantined_at'>): CustomerCallNoteStatus {
  if (t.ghl_note_posted_at) return 'posted';
  if (t.ghl_note_quarantined_at) return 'quarantined';
  return 'pending';
}

export async function listCallNotesForCustomer(
  supabase: SupabaseClient,
  // Every HighLevel contact id this customer's quotes have EVER carried,
  // not just the current/first one. A customer whose quotes were logged
  // under two different HL contact ids over time (a merge, a re-match) has
  // real call history sitting under BOTH -- the admin-lens review on this
  // PR caught the first cut reading only quotes[0].highlevel_contact_id,
  // the same single-id assumption customerTenure.ts's getTenureQuotes
  // deliberately does NOT make (it queries customer_id and hlContactId
  // both, for exactly this reason).
  ghlContactIds: string[],
): Promise<CustomerCallNote[]> {
  const ids = [...new Set(ghlContactIds.filter(Boolean))];
  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from('call_transcripts')
    .select('id, called_at, summary, ghl_note_posted_at, ghl_note_quarantined_at')
    .in('ghl_contact_id', ids)
    .not('summary', 'is', null)
    .order('called_at', { ascending: false, nullsFirst: false })
    .limit(MAX_CALLS);
  if (error) throw error;

  const transcripts = (data ?? []) as TranscriptRow[];
  if (transcripts.length === 0) return [];

  const transcriptIds = transcripts.map(t => t.id);
  const { data: commitmentData, error: commitmentError } = await supabase
    .from('call_commitments')
    .select('id, transcript_id, detail, promised_at')
    .in('transcript_id', transcriptIds)
    .order('extraction_index', { ascending: true });
  if (commitmentError) throw commitmentError;

  const commitments = (commitmentData ?? []) as CommitmentRow[];
  const commitmentIds = commitments.map(c => c.id);

  // The real status lives on office_tasks, one hop away via
  // source_event_id. A read failure here degrades to "unknown" (null)
  // rather than failing the whole panel — a customer's call history is
  // worth showing even if this one join can't be read.
  const statusByCommitmentId = new Map<string, OfficeTaskStatus>();
  if (commitmentIds.length > 0) {
    const { data: taskData, error: taskError } = await supabase
      .from('office_tasks')
      .select('source_event_id, status')
      .eq('source_system', 'call_commitment')
      .in('source_event_id', commitmentIds);
    if (taskError) throw taskError;
    for (const row of (taskData ?? []) as OfficeTaskRow[]) {
      statusByCommitmentId.set(row.source_event_id, row.status);
    }
  }

  const tasksByTranscript = new Map<string, CustomerCallTask[]>();
  for (const row of commitments) {
    const list = tasksByTranscript.get(row.transcript_id) ?? [];
    list.push({
      detail: row.detail,
      promisedAt: row.promised_at,
      status: statusByCommitmentId.get(row.id) ?? null,
    });
    tasksByTranscript.set(row.transcript_id, list);
  }

  return transcripts.map(t => ({
    transcriptId: t.id,
    calledAt: t.called_at,
    // The select above excludes null summaries, so this cast is safe.
    summary: t.summary as string,
    noteStatus: noteStatusOf(t),
    tasks: tasksByTranscript.get(t.id) ?? [],
  }));
}

/**
 * Self-resolving wrapper for the /customers/[contactId] page, matching how
 * its sibling data functions (listJobsForCustomer, listInvoicesForCustomer)
 * source their own client rather than making every caller thread one
 * through. Degrades to an empty list, never an error, both when Supabase is
 * unconfigured and before this feature's migrations are applied — a
 * customer with no call history yet and a customer whose calls haven't
 * been wired up should look identical on this page.
 */
export async function getCallNotesForCustomer(ghlContactIds: string[]): Promise<CustomerCallNote[]> {
  const db = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!db) return [];
  try {
    return await listCallNotesForCustomer(db, ghlContactIds);
  } catch (err) {
    if (isCallNotesSchemaUnavailable(err)) return [];
    throw err;
  }
}
