// The calls-ingest orchestration (calls_merge_plan_2026-08.md slice S2):
// for each pending call_recordings row, hydrate the GHL contact
// (best-effort), fetch the transcript from HighLevel, apply the junk guard,
// insert a call_transcripts row, and mark the recording row done. Shared by
// the cron (GET /api/cron/calls-sync) and the admin page's "process next
// batch" button -- neither route duplicates this logic. Ported from the
// yll-call-copilot repo's src/lib/recordings/pipeline.ts (master fb1bf326),
// stripped of everything out of scope for this slice: no Deepgram audio
// download (decision 3 -- HighLevel supplies the transcript directly), no
// verticals lookup (S3), no learnings extraction (S4), no outcome matching
// (S4, decision 2 -- a local quotes query).
//
// REP IDENTITY (rep-assignment ruling, same day as the fix round): resolves
// row.ghl_user_id -> the rep's email + display name via getGhlUser
// (src/lib/integrations/highlevel.ts), and stores both on the
// call_transcripts row. Cached PER BATCH RUN (repIdentityCache, keyed on
// ghl_user_id): a batch is typically many calls from the same handful of
// reps, so this avoids one GHL round trip per recording for a rep this run
// already resolved. Best-effort, same posture as the contact hydrate below:
// any lookup failure degrades to null fields, never fails the recording.
//
// Best-effort per recording: one failure marks that row 'failed' with a
// detail and the loop moves on -- never a batch abort.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getContact, getGhlUser, isHighLevelConfigured, type GhlUserIdentity } from '../integrations/highlevel';
import { fetchHighLevelTranscript, HighLevelTranscriptUnavailableError } from './transcribeHighLevel';
import { junkReasonFromTurns } from './junk';
import { MIN_RECORDING_SECONDS, PROCESSING_STALE_MS, RECORDING_BATCH_SIZE } from './sync';

export { RECORDING_BATCH_SIZE };

/** Per-run cache for resolveRepIdentity below -- one Map per
 * processPendingRecordings call. Accepted tradeoff: a FAILED lookup is
 * cached like a success, so one transient GHL blip leaves later calls from
 * that same rep unassigned for the rest of the batch; the next batch
 * retries fresh. Cheap, bounded, and self-healing on the next run. */
export type RepIdentityCache = Map<string, GhlUserIdentity>;

/**
 * Resolves a GHL user id to its email/name, cached in `cache` for the
 * lifetime of the current batch run. A lookup failure inside getGhlUser
 * already degrades to { email: null, name: null } (see that function's own
 * comment) -- this wrapper only adds the cache, it does not add its own
 * try/catch, so a cache HIT never re-throws something a MISS wouldn't.
 */
async function resolveRepIdentity(ghlUserId: string | null, cache: RepIdentityCache): Promise<GhlUserIdentity> {
  if (!ghlUserId) return { email: null, name: null };
  const cached = cache.get(ghlUserId);
  if (cached) return cached;
  const identity = await getGhlUser(ghlUserId);
  cache.set(ghlUserId, identity);
  return identity;
}

type CallRecordingRow = {
  id: string;
  ghl_message_id: string | null;
  ghl_contact_id: string | null;
  ghl_user_id: string | null;
  direction: string | null;
  called_at: string | null;
  duration_seconds: number | null;
  status: string;
  processing_at: string | null;
};

async function markRow(supabase: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<void> {
  await supabase.from('call_recordings').update(patch).eq('id', id);
}

export type ProcessOutcome = 'transcribed' | 'skipped' | 'failed';

// Processes one call_recordings row through to completion (or a recorded
// failure). Exported on its own -- not just via processPendingRecordings --
// so a caller that already has the row in hand doesn't need a second DB
// round trip to re-select it.
export async function processOneRecording(
  supabase: SupabaseClient,
  row: CallRecordingRow,
  repIdentityCache: RepIdentityCache = new Map(),
): Promise<ProcessOutcome> {
  try {
    if (!row.ghl_message_id) {
      await markRow(supabase, row.id, { status: 'failed', detail: { error: 'Missing ghl_message_id.' } });
      return 'failed';
    }
    if (row.duration_seconds != null && row.duration_seconds < MIN_RECORDING_SECONDS) {
      await markRow(supabase, row.id, { status: 'skipped', skip_reason: 'duration_under_20s' });
      return 'skipped';
    }
    if (!isHighLevelConfigured()) {
      await markRow(supabase, row.id, { status: 'failed', detail: { error: 'HighLevel not configured.' } });
      return 'failed';
    }

    // Hydrate the contact once, best-effort -- feeds customer_phone/
    // customer_name on the resulting transcript row. A hydrate failure
    // degrades to nulls rather than failing the whole recording -- the call
    // still gets transcribed.
    let customerPhone: string | null = null;
    let customerName: string | null = null;
    if (row.ghl_contact_id) {
      try {
        const contact = await getContact(row.ghl_contact_id);
        customerPhone = contact.phone ?? null;
        customerName = contact.fullName ?? null;
      } catch (err) {
        console.error(`GHL contact hydrate failed for recording ${row.id}:`, err);
      }
    }

    // Rep identity, cached per batch run -- best-effort, same posture as the
    // contact hydrate above: a failure degrades to nulls (getGhlUser never
    // throws), never fails the recording.
    const repIdentity = await resolveRepIdentity(row.ghl_user_id, repIdentityCache);

    let transcribed;
    try {
      transcribed = await fetchHighLevelTranscript(row.ghl_message_id);
    } catch (err) {
      if (err instanceof HighLevelTranscriptUnavailableError) {
        await markRow(supabase, row.id, { status: 'failed', detail: { error: err.message } });
        return 'failed';
      }
      throw err;
    }

    // Junk gate applies POST-transcription (voicemail/IVR/one-sided calls
    // duration alone can't catch); the under-20s check above already ran
    // pre-transcription.
    const junk = junkReasonFromTurns(transcribed.utterances.map(u => ({ speaker: String(u.speaker), text: u.text })));
    if (junk) {
      await markRow(supabase, row.id, { status: 'skipped', skip_reason: junk });
      return 'skipped';
    }

    const { data: transcriptData, error: insertError } = await supabase
      .from('call_transcripts')
      .insert({
        source: `ghl:${row.ghl_message_id}`,
        customer_name: customerName,
        customer_phone: customerPhone,
        called_at: row.called_at,
        raw_text: transcribed.rawText,
        utterances: transcribed.utterances,
        // rep_email/rep_name resolved above (best-effort, cached per batch
        // run). rep_ghl_user_id stays the ground-truth id from the call
        // message regardless of whether the lookup succeeded.
        rep_email: repIdentity.email,
        rep_name: repIdentity.name,
        rep_ghl_user_id: row.ghl_user_id,
        direction: row.direction,
        // Math.round both sources: the column is an integer, and the
        // HighLevel adapter derives duration from sentence end times, which
        // can be fractional.
        duration_seconds: Math.round(transcribed.durationSeconds || row.duration_seconds || 0),
        ghl_contact_id: row.ghl_contact_id,
      })
      .select('id')
      .single();
    if (insertError) throw insertError;
    const transcriptId = (transcriptData as { id: string }).id;

    await markRow(supabase, row.id, { status: 'transcribed', transcript_id: transcriptId });
    return 'transcribed';
  } catch (err) {
    console.error(`Failed to process recording ${row.id}:`, err);
    await markRow(supabase, row.id, {
      status: 'failed',
      // JSON.stringify, not String(): a thrown Supabase/PostgREST error is a
      // plain object and String() buries the message as "[object Object]".
      detail: { error: err instanceof Error ? err.message : JSON.stringify(err) },
    }).catch(() => {});
    return 'failed';
  }
}

// Claims one candidate row for THIS invocation via a compare-and-swap
// update: the WHERE clause only matches if the row is still in the exact
// state we read it in (plain 'pending', or a 'processing' row whose
// processing_at is still older than the stale cutoff). If the cron and a
// staff click on the admin page race on the same row, only one update
// matches and the other gets zero rows back. Exported so the race itself is
// directly testable without driving the whole batch loop.
export async function claimRecording(
  supabase: SupabaseClient,
  row: Pick<CallRecordingRow, 'id' | 'status'>,
  now: Date = new Date(),
): Promise<boolean> {
  const nowIso = now.toISOString();
  const cutoffIso = new Date(now.getTime() - PROCESSING_STALE_MS).toISOString();

  const base = supabase
    .from('call_recordings')
    .update({ status: 'processing', processing_at: nowIso })
    .eq('id', row.id);
  const query =
    row.status === 'processing'
      ? base.eq('status', 'processing').lt('processing_at', cutoffIso)
      : base.eq('status', 'pending');

  const { data, error } = await query.select('id');
  if (error) throw error;
  return (data ?? []).length > 0;
}

export type ProcessRecordingsResult = { done: number; skipped: number; failed: number };

export async function processPendingRecordings(
  supabase: SupabaseClient,
  limit: number = RECORDING_BATCH_SIZE,
  now: Date = new Date(),
): Promise<ProcessRecordingsResult> {
  const cutoffIso = new Date(now.getTime() - PROCESSING_STALE_MS).toISOString();
  // Candidates are plain-pending rows PLUS abandoned-processing rows (a
  // crashed invocation left processing_at stale) -- the claim step below is
  // what actually guards against double-processing a row a concurrent,
  // still-live invocation is working on.
  const { data, error } = await supabase
    .from('call_recordings')
    .select('id, ghl_message_id, ghl_contact_id, ghl_user_id, direction, called_at, duration_seconds, status, processing_at')
    .or(`status.eq.pending,and(status.eq.processing,processing_at.lt.${cutoffIso})`)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;

  const rows = (data ?? []) as CallRecordingRow[];
  if (rows.length === 0) return { done: 0, skipped: 0, failed: 0 };

  // One rep-identity cache for the WHOLE batch -- a batch is typically many
  // calls from the same handful of reps, so this avoids a GHL round trip
  // per recording for a rep this run already resolved (see this file's
  // header).
  const repIdentityCache: RepIdentityCache = new Map();

  let done = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    const claimed = await claimRecording(supabase, row, now);
    if (!claimed) continue; // another invocation claimed this row first -- not double-spent, not counted here
    const outcome = await processOneRecording(supabase, row, repIdentityCache);
    if (outcome === 'transcribed') done++;
    else if (outcome === 'skipped') skipped++;
    else failed++;
  }

  return { done, skipped, failed };
}
