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
  // Admin-lens finding: the preview showed only opaque HighLevel/transcript
  // ids, so a human reviewing it before --live had no way to tell which
  // real customer each entry belongs to without a separate lookup.
  customerName: string | null;
  body: string;
};

export type CommentBackfillResult = {
  commented: number;
  failed: number;
  previewed: number;
  skippedTest: number;
  // A comment that DID post to HighLevel but whose local marker write then
  // failed. Counted apart from `failed` on purpose: `failed` means nothing
  // reached the CRM and the row is safe to retry; this means the opposite,
  // and re-running the script for that id would risk a duplicate.
  postedButNotRecorded: number;
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
  customer_name: string | null;
  is_test: boolean;
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

// How stale a call has to be before the comment names its own age.
// composeCallNote's body says nothing about when the call happened (it
// posts within the hour on the live path, so "now" is close enough there
// not to matter); a backfilled comment can land days after the call, and
// an admin-lens review flagged that a comment posted "today" describing a
// call from over a week ago could read to a rep as if it just happened.
const STALE_AFTER_MS = 24 * 3_600_000;

function backdatedPrefix(calledAt: string | null, now: Date): string {
  if (!calledAt) return '';
  const at = new Date(calledAt);
  if (Number.isNaN(at.getTime()) || now.getTime() - at.getTime() < STALE_AFTER_MS) return '';
  const when = at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `[Backfilled: this call happened on ${when}, this comment was added later]\n\n`;
}

export async function backfillMissingComments(
  supabase: SupabaseClient,
  limit: number = BACKFILL_COMMENTS_BATCH_SIZE,
  options: CommentBackfillOptions = {},
  now: Date = new Date(),
): Promise<CommentBackfillResult> {
  const dryRun = options.dryRun === true;

  const { data, error } = await supabase
    .from('call_transcripts')
    .select('id, called_at, ghl_contact_id, summary, customer_name, is_test')
    .not('ghl_note_posted_at', 'is', null)
    .is('ghl_comment_posted_at', null)
    .not('ghl_contact_id', 'is', null)
    .order('called_at', { ascending: true, nullsFirst: false })
    .limit(Math.max(1, limit));
  if (error) throw error;

  const rows = (data ?? []) as TranscriptRow[];
  const result: CommentBackfillResult = {
    commented: 0, failed: 0, previewed: 0, skippedTest: 0, postedButNotRecorded: 0,
  };

  for (const row of rows) {
    // A test row must never reach the live CRM. The candidate set should
    // already exclude these (a test call's note never posts in the first
    // place, per postNotes.ts's own skip check), but this script does not
    // rely on that upstream guarantee holding forever — it checks again,
    // the same posture the live worker leads with.
    if (row.is_test) {
      console.error(`Skipping call ${row.id}: is_test.`);
      result.skippedTest++;
      continue;
    }

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
      const body = backdatedPrefix(row.called_at, now) + composeCallNote({ summary: row.summary, commitments });

      if (dryRun) {
        options.onPreview?.({
          transcriptId: row.id,
          contactId,
          calledAt: row.called_at,
          customerName: row.customer_name,
          body,
        });
        result.previewed++;
        continue;
      }

      await createInternalComment(contactId, body);

      // THE COMMENT NOW EXISTS IN THE CRM. From here the only wrong outcome
      // is posting it a second time, so this write gets its own catch: it
      // must never fall back into the outer catch's ordinary "failed, safe
      // to retry" bucket. A technical-lens review on this PR named the real
      // risk precisely: a human seeing `failed: N` in the output is exactly
      // who re-runs this script, and a row here would look identical to one
      // that was never attempted.
      try {
        await patchRow(supabase, row.id, { ghl_comment_posted_at: new Date().toISOString() });
        result.commented++;
      } catch (markErr) {
        console.error(
          `POSTED the HighLevel comment for call ${row.id} but could NOT record it locally. ` +
          `Do not re-run this script until you have confirmed by hand (in HighLevel) whether ` +
          `${row.id} already has the comment, or it may post twice.`,
          markErr,
        );
        result.postedButNotRecorded++;
      }
    } catch (err) {
      console.error(`Backfill comment failed for call ${row.id}:`, err);
      result.failed++;
    }
  }

  return result;
}
