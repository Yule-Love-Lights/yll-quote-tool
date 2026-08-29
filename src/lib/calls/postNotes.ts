// The post-call HighLevel note worker (Naldo's ask, 2026-08-29): takes
// call_transcripts rows that have been transcribed and commitment-extracted
// but not yet noted, and posts one internal note per call onto that
// customer's HighLevel contact carrying the call summary and the tasks that
// came out of it.
//
// WHY THIS IS ITS OWN PHASE rather than a step inside the commitment
// backfill: every transcript already in the table on the day this shipped
// was already extracted, and backfillCommitments permanently excludes a
// transcript once commitments_extracted_at is set. A note producer hanging
// off the extraction loop would therefore have posted nothing for any
// existing call. This phase selects on the note markers instead, so it
// picks up both the backlog and every future call.
//
// THE IDEMPOTENCY GUARANTEE, which matters because the write is to a live
// CRM and a duplicate note is visible to staff forever:
//   1. The candidate query only returns rows with ghl_note_posted_at null.
//   2. The claim is a compare-and-swap on ghl_note_attempts: two workers
//      reading the same row both try to move it from N to N+1, and only one
//      update matches. The loser posts nothing.
//   3. ghl_note_posted_at is written ONLY after HighLevel returns success.
// The window that remains: HighLevel accepts the note and the marker write
// then fails. A review round correctly pointed out this is NOT only a
// process crash, it is any transient database failure on that write, which
// is far more likely. So the marker write now has its own try/catch and,
// when it fails, the row is QUARANTINED rather than left to retry. That
// trades a row reading as un-noted for never posting the note twice, which
// is the right way round: a duplicate note sits on a customer's record
// forever, a low count on an admin page does not. A true duplicate now
// requires BOTH writes to fail, meaning the database is unreachable, and
// even then it is bounded by CALL_NOTE_MAX_ATTEMPTS. Closing it completely
// would need a transaction spanning an external API, which does not exist.
//
// Best-effort per call, matching src/lib/calls/pipeline.ts: one failure
// records a reason on that row and the loop moves on, never a batch abort.

import type { SupabaseClient } from '@supabase/supabase-js';
import { createContactNote } from '../integrations/highlevel';
import { summarizeCall, SUMMARY_MODEL, TerminalSummaryError } from './summarize';
import { composeCallNote, type NoteCommitment } from './noteBody';

// How many calls one invocation notes. Each is at most one Haiku call plus
// one HighLevel round trip, so this sits in the same range as the sibling
// batches (RECORDING_BATCH_SIZE, COMMITMENT_EXTRACTION_BATCH_SIZE).
export const CALL_NOTE_BATCH_SIZE = 6;

// After this many claimed attempts a call is quarantined, so one poisoned
// row cannot occupy a batch slot forever. Same posture as the commitment
// extractor's quarantine.
export const CALL_NOTE_MAX_ATTEMPTS = 3;

// How long a claim is honoured before another invocation may reclaim the
// row. Long enough that a slow-but-alive worker is never raced, short
// enough that a crashed one is retried the same hour.
export const CALL_NOTE_CLAIM_STALE_MS = 10 * 60 * 1000;

export type NoteCandidate = {
  id: string;
  raw_text: string;
  called_at: string | null;
  ghl_contact_id: string | null;
  is_test: boolean;
  summary: string | null;
  ghl_note_attempts: number;
};

export type NotePreview = {
  transcriptId: string;
  contactId: string;
  calledAt: string | null;
  body: string;
};

export type PostNotesResult = {
  posted: number;
  skipped: number;
  failed: number;
  quarantined: number;
  contended: number;
  previewed: number;
};

export type PostNotesOptions = {
  /** Compose everything for real, write nothing and post nothing. */
  dryRun?: boolean;
  onPreview?: (preview: NotePreview) => void;
};

const CANDIDATE_COLUMNS = 'id, raw_text, called_at, ghl_contact_id, is_test, summary, ghl_note_attempts';

async function patchRow(
  supabase: SupabaseClient,
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from('call_transcripts').update(patch).eq('id', id);
  if (error) throw error;
}

/**
 * Claims one row for THIS invocation. ghl_note_attempts is both the counter
 * and the compare-and-swap token: the update only matches while the row is
 * still on the attempt count we read, and still unposted.
 *
 * Exported so the race is directly testable without driving a whole batch.
 */
export async function claimNoteRow(
  supabase: SupabaseClient,
  row: Pick<NoteCandidate, 'id' | 'ghl_note_attempts'>,
  now: Date,
): Promise<boolean> {
  const nowIso = now.toISOString();
  const { data, error } = await supabase
    .from('call_transcripts')
    .update({
      ghl_note_claimed_at: nowIso,
      ghl_note_last_attempt_at: nowIso,
      ghl_note_attempts: row.ghl_note_attempts + 1,
    })
    .eq('id', row.id)
    .eq('ghl_note_attempts', row.ghl_note_attempts)
    .is('ghl_note_posted_at', null)
    .select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Pulls the note id out of whatever HighLevel returned.
 *
 * The first cut read `note.id` off the top level, and six real notes posted
 * to production with a null id before the database showed it: HighLevel
 * wraps the created note, it does not return it bare. A read-only GET of
 * /contacts/{id}/notes confirms the note object itself carries `id`, so all
 * three plausible wrappers are accepted here rather than guessing one.
 *
 * The id is not decoration. It is the only thing that makes a bad batch of
 * notes enumerable, and therefore deletable, without hunting a CRM by hand.
 *
 * Exported, like claimNoteRow above, so every shape is directly testable
 * without driving a whole batch through a mocked HighLevel.
 */
export function noteIdFrom(response: unknown): string | null {
  const r = response as {
    id?: unknown;
    note?: { id?: unknown } | null;
    notes?: { id?: unknown }[] | null;
  } | null | undefined;
  if (typeof r?.id === 'string' && r.id) return r.id;
  if (typeof r?.note?.id === 'string' && r.note.id) return r.note.id;
  const first = r?.notes?.[0];
  if (typeof first?.id === 'string' && first.id) return first.id;
  return null;
}

async function loadCommitments(
  supabase: SupabaseClient,
  transcriptId: string,
): Promise<NoteCommitment[]> {
  const { data, error } = await supabase
    .from('call_commitments')
    .select('kind, detail, promised_at')
    .eq('transcript_id', transcriptId)
    .order('extraction_index', { ascending: true });
  if (error) throw error;
  return (data ?? []) as NoteCommitment[];
}

export async function postPendingCallNotes(
  supabase: SupabaseClient,
  limit: number = CALL_NOTE_BATCH_SIZE,
  now: Date = new Date(),
  options: PostNotesOptions = {},
): Promise<PostNotesResult> {
  const dryRun = options.dryRun === true;
  const staleCutoff = new Date(now.getTime() - CALL_NOTE_CLAIM_STALE_MS).toISOString();

  // Candidates are calls that are transcribed, commitment-extracted (so the
  // task list in the note is complete), still unposted, not permanently
  // skipped, not quarantined, and either unclaimed or holding a stale claim
  // from a crashed invocation. Oldest call first, so the backlog drains in
  // the order the calls happened.
  const { data, error } = await supabase
    .from('call_transcripts')
    .select(CANDIDATE_COLUMNS)
    .is('ghl_note_posted_at', null)
    .is('ghl_note_skip_reason', null)
    .is('ghl_note_quarantined_at', null)
    .not('commitments_extracted_at', 'is', null)
    .or(`ghl_note_claimed_at.is.null,ghl_note_claimed_at.lt.${staleCutoff}`)
    .order('called_at', { ascending: true, nullsFirst: true })
    .limit(Math.max(1, limit));
  if (error) throw error;

  const rows = (data ?? []) as NoteCandidate[];
  const result: PostNotesResult = {
    posted: 0, skipped: 0, failed: 0, quarantined: 0, contended: 0, previewed: 0,
  };

  for (const row of rows) {
    // Permanent, non-failure exclusions. Marked so the row leaves the queue
    // instead of being re-read every batch forever. A test row must never
    // reach the live CRM, so this check comes before anything else.
    const skipReason = row.is_test
      ? 'is_test'
      : !row.ghl_contact_id
        ? 'no_contact_id'
        : null;
    if (skipReason) {
      // Wrapped like every other mutating call in this loop. Before the fix
      // round this was the one that was not, so a transient DB error on a
      // test row aborted the entire batch, contradicting this file's own
      // never-a-batch-abort promise.
      if (!dryRun) {
        try {
          await patchRow(supabase, row.id, { ghl_note_skip_reason: skipReason });
        } catch (err) {
          console.error(`Could not mark call ${row.id} as skipped (${skipReason}):`, err);
          result.failed++;
          continue;
        }
      }
      result.skipped++;
      continue;
    }
    const contactId = row.ghl_contact_id as string;

    // Claim BEFORE summarising: the summary is the expensive part, and two
    // workers should never pay for it twice on the same call.
    if (!dryRun) {
      let claimed: boolean;
      try {
        claimed = await claimNoteRow(supabase, row, now);
      } catch (err) {
        console.error(`Could not claim call ${row.id} for a HighLevel note:`, err);
        result.failed++;
        continue;
      }
      if (!claimed) {
        result.contended++;
        continue;
      }
    }

    const attemptsAfterClaim = row.ghl_note_attempts + 1;
    let phase: 'summary' | 'commitments' | 'post' = 'summary';
    try {
      let summary = row.summary;
      if (!summary) {
        summary = await summarizeCall(row.raw_text);
        // Stored before the post, so a HighLevel failure does not throw the
        // summary away and re-bill for it on the retry.
        if (!dryRun) {
          await patchRow(supabase, row.id, {
            summary,
            summary_model: SUMMARY_MODEL,
            summary_generated_at: now.toISOString(),
          });
        }
      }

      phase = 'commitments';
      const commitments = await loadCommitments(supabase, row.id);
      const body = composeCallNote({ summary, commitments });

      if (dryRun) {
        options.onPreview?.({ transcriptId: row.id, contactId, calledAt: row.called_at, body });
        result.previewed++;
        continue;
      }

      phase = 'post';
      const note = await createContactNote(contactId, body);

      // THE NOTE NOW EXISTS IN THE CRM. From here the only wrong outcome is
      // posting it a SECOND time, so this write gets its own try/catch: it
      // must never fall into the retry path below. If the marker cannot be
      // written we quarantine the row instead, which stops the retry at the
      // cost of the row reading as un-noted on the admin page. A note the
      // customer's record shows twice is worse than a count that reads low.
      const noteId = noteIdFrom(note);
      if (!noteId) {
        // Not fatal, the note exists either way. Logged loudly because a
        // null id here means this batch cannot be cleaned up in bulk later,
        // which is exactly how the first six went out unnoticed.
        console.warn(`HighLevel returned no note id for call ${row.id}; the note posted but cannot be traced.`);
      }
      try {
        await patchRow(supabase, row.id, {
          ghl_note_posted_at: new Date().toISOString(),
          ghl_note_id: noteId,
          ghl_note_last_failure_code: null,
        });
        result.posted++;
      } catch (markErr) {
        console.error(`Posted the HighLevel note for call ${row.id} but could not record it:`, markErr);
        result.failed++;
        try {
          await patchRow(supabase, row.id, {
            ghl_note_quarantined_at: now.toISOString(),
            ghl_note_last_failure_code: 'posted_marker_failed',
          });
          result.quarantined++;
        } catch (quarantineErr) {
          // Both writes failed, so the database is unreachable. This is the
          // one path that can genuinely produce a duplicate note, and it is
          // now the ONLY one.
          console.error(`Could not quarantine call ${row.id} after a recorded-post failure:`, quarantineErr);
        }
      }
      continue;
    } catch (err) {
      console.error(`Failed to post the HighLevel note for call ${row.id}:`, err);
      result.failed++;
      if (dryRun) continue;

      const failureCode = phase === 'post'
        ? 'highlevel_post_failed'
        : phase === 'commitments'
          ? 'commitments_read_failed'
          : err instanceof TerminalSummaryError
            ? 'summary_terminal'
            : 'summary_failed';
      const quarantine = attemptsAfterClaim >= CALL_NOTE_MAX_ATTEMPTS;
      try {
        await patchRow(supabase, row.id, {
          ghl_note_last_failure_code: failureCode,
          ...(quarantine ? { ghl_note_quarantined_at: now.toISOString() } : {}),
        });
        if (quarantine) result.quarantined++;
      } catch (markErr) {
        // The claim already stands, so this row simply retries after the
        // stale window. Logged rather than thrown: one row's bookkeeping
        // failure must not abort the rest of the batch.
        console.error(`Could not record the note failure for call ${row.id}:`, markErr);
      }
    }
  }

  return result;
}
