// One-off backfill (Naldo's ask, 2026-08-31): posts the internal comment
// for every call that already has a HighLevel note but shipped before the
// comment feature (#1131) existed, so it never got one. Not a cron, not
// wired into anything scheduled — run once by hand via
// scripts/backfill-call-comments.ts.
//
// The candidate set is exactly ghl_note_posted_at not null AND
// ghl_comment_posted_at null: every row this catches already has a
// reviewed, working note sitting on a real contact, so the comment is a
// known-safe echo of content that already shipped, not a first-time write.
//
// NO CAS/claim here, unlike postNotes.ts's claimNoteRow. This is a manual,
// sequential, run-by-hand script, not a scheduled worker two invocations
// could race — the risk a claim token exists to prevent doesn't apply the
// same way. Run it once, live, and stop; do not wire this into a cron.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createInternalComment } from '../integrations/highlevel';
import { composeCallNote, type NoteCommitment } from './noteBody';

export const BACKFILL_COMMENTS_BATCH_SIZE = 100;

export type CommentBackfillPreview = {
  transcriptId: string;
  contactId: string;
  calledAt: string | null;
  body: string;
};

export type CommentBackfillResult = {
  commented: number;
  failed: number;
  previewed: number;
};

export type CommentBackfillOptions = {
  dryRun?: boolean;
  onPreview?: (preview: CommentBackfillPreview) => void;
};

type TranscriptRow = {
  id: string;
  called_at: string | null;
  ghl_contact_id: string | null;
  summary: string | null;
};

async function patchRow(supabase: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('call_transcripts').update(patch).eq('id', id);
  if (error) throw error;
}

async function loadCommitments(supabase: SupabaseClient, transcriptId: string): Promise<NoteCommitment[]> {
  const { data, error } = await supabase
    .from('call_commitments')
    .select('kind, detail, promised_at')
    .eq('transcript_id', transcriptId)
    .order('extraction_index', { ascending: true });
  if (error) throw error;
  return (data ?? []) as NoteCommitment[];
}

export async function backfillMissingComments(
  supabase: SupabaseClient,
  limit: number = BACKFILL_COMMENTS_BATCH_SIZE,
  options: CommentBackfillOptions = {},
): Promise<CommentBackfillResult> {
  const dryRun = options.dryRun === true;

  const { data, error } = await supabase
    .from('call_transcripts')
    .select('id, called_at, ghl_contact_id, summary')
    .not('ghl_note_posted_at', 'is', null)
    .is('ghl_comment_posted_at', null)
    .not('ghl_contact_id', 'is', null)
    .order('called_at', { ascending: true, nullsFirst: false })
    .limit(Math.max(1, limit));
  if (error) throw error;

  const rows = (data ?? []) as TranscriptRow[];
  const result: CommentBackfillResult = { commented: 0, failed: 0, previewed: 0 };

  for (const row of rows) {
    // The candidate query already requires both, but a row missing either
    // by the time it's read here is skipped rather than crashing the batch
    // over one bad row.
    if (!row.summary || !row.ghl_contact_id) {
      console.error(`Skipping call ${row.id}: missing summary or contact id.`);
      result.failed++;
      continue;
    }
    const contactId = row.ghl_contact_id;

    try {
      const commitments = await loadCommitments(supabase, row.id);
      const body = composeCallNote({ summary: row.summary, commitments });

      if (dryRun) {
        options.onPreview?.({ transcriptId: row.id, contactId, calledAt: row.called_at, body });
        result.previewed++;
        continue;
      }

      await createInternalComment(contactId, body);
      await patchRow(supabase, row.id, { ghl_comment_posted_at: new Date().toISOString() });
      result.commented++;
    } catch (err) {
      console.error(`Backfill comment failed for call ${row.id}:`, err);
      result.failed++;
    }
  }

  return result;
}
