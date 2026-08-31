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

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseServiceClient, getSupabaseClient } from '../supabase';
import { isCallNotesSchemaUnavailable } from './errors';

export type CustomerCallTask = {
  detail: string;
  promisedAt: string | null;
};

export type CustomerCallNote = {
  transcriptId: string;
  calledAt: string | null;
  summary: string;
  /** Whether the HighLevel note/comment have posted for this call yet. */
  posted: boolean;
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
};

type CommitmentRow = {
  transcript_id: string;
  detail: string;
  promised_at: string | null;
};

export async function listCallNotesForCustomer(
  supabase: SupabaseClient,
  ghlContactId: string | null,
): Promise<CustomerCallNote[]> {
  if (!ghlContactId) return [];

  const { data, error } = await supabase
    .from('call_transcripts')
    .select('id, called_at, summary, ghl_note_posted_at')
    .eq('ghl_contact_id', ghlContactId)
    .not('summary', 'is', null)
    .order('called_at', { ascending: false, nullsFirst: false })
    .limit(MAX_CALLS);
  if (error) throw error;

  const transcripts = (data ?? []) as TranscriptRow[];
  if (transcripts.length === 0) return [];

  const transcriptIds = transcripts.map(t => t.id);
  const { data: commitmentData, error: commitmentError } = await supabase
    .from('call_commitments')
    .select('transcript_id, detail, promised_at')
    .in('transcript_id', transcriptIds)
    .order('extraction_index', { ascending: true });
  if (commitmentError) throw commitmentError;

  const tasksByTranscript = new Map<string, CustomerCallTask[]>();
  for (const row of (commitmentData ?? []) as CommitmentRow[]) {
    const list = tasksByTranscript.get(row.transcript_id) ?? [];
    list.push({ detail: row.detail, promisedAt: row.promised_at });
    tasksByTranscript.set(row.transcript_id, list);
  }

  return transcripts.map(t => ({
    transcriptId: t.id,
    calledAt: t.called_at,
    // The select above excludes null summaries, so this cast is safe.
    summary: t.summary as string,
    posted: t.ghl_note_posted_at != null,
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
export async function getCallNotesForCustomer(ghlContactId: string | null): Promise<CustomerCallNote[]> {
  const db = getSupabaseServiceClient() ?? getSupabaseClient();
  if (!db) return [];
  try {
    return await listCallNotesForCustomer(db, ghlContactId);
  } catch (err) {
    if (isCallNotesSchemaUnavailable(err)) return [];
    throw err;
  }
}
