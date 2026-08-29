// Pure sync-window math for the calls-sync cron (calls_merge_plan_2026-08.md
// slice S2). Ported from the yll-call-copilot repo's src/lib/recordings/
// sync.ts and src/app/api/cron/sync-recordings/route.ts (master fb1bf326).
// Kept separate from the DB/GHL IO so "since when do we ask GHL for calls"
// is unit-testable without a live database or a live GHL account.

const FIRST_RUN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// The first run has no recording_sync_state row yet (lastSyncedAt null) --
// default to a 7-day lookback so the first sync backfills a reasonable
// window of recent calls instead of pulling the whole account history.
// Every later run passes the previous run's stored last_synced_at,
// narrowing the window to just what's new.
export function resolveSyncWindowStart(lastSyncedAt: string | null, now: Date = new Date()): string {
  if (lastSyncedAt) return lastSyncedAt;
  return new Date(now.getTime() - FIRST_RUN_LOOKBACK_MS).toISOString();
}

// How many pending recordings a single cron/manual-batch invocation
// processes. Shared so "process the next batch" means the same thing
// whether it's the cron or the admin page's button.
export const RECORDING_BATCH_SIZE = 6;

// Below this, a call is never worth transcribing -- a dropped call, a wrong
// number hung up in seconds, etc. Checked against the duration GHL itself
// reports for the call message, BEFORE calling the transcription endpoint,
// so those calls never spend an API call. The post-transcription junk
// detector (junkReasonFromTurns) catches everything duration alone can't
// (voicemail/IVR, one-sided calls).
export const MIN_RECORDING_SECONDS = 20;

// HighLevel can make a completed call visible after its dateAdded timestamp.
// Re-scan one day on every completed window; ghl_message_id's unique
// constraint makes the overlap idempotent, while delayed provider
// visibility no longer creates a hole.
export const PROVIDER_VISIBILITY_OVERLAP_MS = 24 * 60 * 60 * 1000;

// How many export results a single cron invocation asks for before
// truncating (distinct from the provider's own 1000/page cursor limit in
// ghlRecordings.ts) -- large enough to cover a normal day's backlog in one
// database batch while still letting a bigger backlog drain over
// successive safe cursors.
export const BACKLOG_FETCH_LIMIT = 500;

// A 'processing' row whose processing_at is older than this is treated as
// abandoned (the invocation that claimed it crashed or timed out) and is
// reclaimed by the next run instead of being stuck forever.
export const PROCESSING_STALE_MS = 15 * 60 * 1000;

/**
 * The export fetcher supplies an exclusive continuation (`nextSince`) only
 * after it has proven the entire boundary timestamp was scanned. A
 * COMPLETED window (stopReason !== truncated) deliberately keeps a one-day
 * overlap for provider visibility lag instead of jumping straight to
 * `runStartedAt` -- pure so the overlap math is testable without a live
 * clock or database.
 */
export function resolveOverlapCursor(
  sinceIso: string,
  runStartedIso: string,
  overlapMs: number = PROVIDER_VISIBILITY_OVERLAP_MS,
): string {
  return new Date(
    Math.max(new Date(sinceIso).getTime(), new Date(runStartedIso).getTime() - overlapMs),
  ).toISOString();
}

/**
 * Chooses the next persisted cursor for one sync run. An upsert failure
 * keeps `since` unchanged (a failed insert must not be treated as "seen"),
 * an untruncated (fully-drained) window applies the visibility overlap, and
 * a truncated window continues from the fetcher's own proven-safe
 * continuation (falling back to `since` in the unreachable case where
 * truncation reports no continuation at all).
 */
export function resolveNextSyncCursor(input: {
  since: string;
  runStartedAt: string;
  truncated: boolean;
  nextSince: string | null;
  upsertFailed: boolean;
}): string {
  const { since, runStartedAt, truncated, nextSince, upsertFailed } = input;
  if (upsertFailed) return since;
  if (!truncated) return resolveOverlapCursor(since, runStartedAt);
  return nextSince ?? since;
}
