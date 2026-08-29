// GET /api/cron/calls-sync — the calls-ingest cron (calls_merge_plan_2026-08.md
// slice S2, decision 5): pulls newly-completed call messages from HighLevel
// since the last sync, upserts them into call_recordings (idempotent on
// ghl_message_id -- a re-run never double-inserts the same call), advances
// recording_sync_state, then processes up to RECORDING_BATCH_SIZE pending
// recordings in this same invocation. Same shape as the repo's other crons
// (e.g. /api/dashboard/ghl/reconcile): GET only (Vercel Cron only ever
// issues GET), allowlisted in operatorGate.ts (a cron request carries no
// operator session), CRON_SECRET-guarded via cronDenial.
//
// CALLS_SYNC_ENABLED is a SEPARATE off-by-default kill switch (decision 5:
// "each pipeline gets its own enable flag, default off, so a valid deploy
// runs nothing until Naldo turns each timer on explicitly"). Registered in
// vercel.json by this PR, but left unset, so a merge activates the
// schedule while the route itself keeps no-oping until Naldo sets the flag.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { isHighLevelConfigured } from '@/lib/integrations/highlevel';
import { listRecentCallRecordings } from '@/lib/calls/ghlRecordings';
import { processPendingRecordings } from '@/lib/calls/pipeline';
import { BACKLOG_FETCH_LIMIT, RECORDING_BATCH_SIZE, resolveNextSyncCursor, resolveSyncWindowStart } from '@/lib/calls/sync';
import { isMissingTableError } from '@/lib/calls/errors';
import { cronDenial } from '@/lib/auth/cronAuth';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const denied = cronDenial(req.headers.get('authorization'));
  if (denied) return denied;

  if (process.env.CALLS_SYNC_ENABLED !== 'true') {
    return NextResponse.json({ ran: false, reason: 'CALLS_SYNC_ENABLED is not set.' });
  }
  if (!isSupabaseServiceConfigured()) {
    return NextResponse.json({ ran: false, reason: 'Supabase not configured.' });
  }
  if (!isHighLevelConfigured()) {
    return NextResponse.json({ ran: false, reason: 'HighLevel not configured.' });
  }

  const supabase = getSupabaseServiceClient()!;

  try {
    const { data: stateData, error: stateError } = await supabase
      .from('recording_sync_state')
      .select('last_synced_at')
      .eq('id', 1)
      .maybeSingle();
    if (stateError) throw stateError;
    const lastSyncedAt = (stateData as { last_synced_at: string | null } | null)?.last_synced_at ?? null;
    const since = resolveSyncWindowStart(lastSyncedAt);

    // Captured BEFORE the GHL fetch, not after: if a call's dateAdded lands
    // during the fetch, stamping a post-fetch time would push the next
    // run's `since` past that call, permanently skipping it. The
    // ghl_message_id unique constraint dedupes the resulting small overlap
    // between runs for free.
    const runStartedAt = new Date().toISOString();
    const { messages, truncated, stopReason, nextSince } = await listRecentCallRecordings(
      since,
      BACKLOG_FETCH_LIMIT,
      runStartedAt,
    );

    let inserted = 0;
    let upsertFailed = 0;
    for (const m of messages) {
      const { data, error } = await supabase
        .from('call_recordings')
        .upsert(
          {
            ghl_message_id: m.messageId,
            ghl_contact_id: m.contactId,
            ghl_conversation_id: m.conversationId,
            ghl_user_id: m.userId,
            direction: m.direction,
            called_at: m.dateAdded,
            duration_seconds: m.durationSeconds,
          },
          { onConflict: 'ghl_message_id', ignoreDuplicates: true },
        )
        .select('id');
      if (error) {
        console.error('Upsert call_recordings failed:', error);
        upsertFailed++;
        continue;
      }
      if (data && data.length > 0) inserted++;
    }

    const requestedNextCursor = resolveNextSyncCursor({
      since,
      runStartedAt,
      truncated,
      nextSince,
      upsertFailed: upsertFailed > 0,
    });

    // The database routine takes a row lock and applies GREATEST, so a
    // stale overlapping cron invocation can never move a newer cursor
    // backward.
    const { data: storedCursor, error: syncStateError } = await supabase.rpc('advance_recording_sync_cursor', {
      p_next_cursor: requestedNextCursor,
      p_detail: {
        messages_seen: messages.length,
        inserted,
        upsert_failed: upsertFailed,
        truncated,
        stop_reason: stopReason,
      },
    });
    if (syncStateError) throw syncStateError;
    const actualCursor = typeof storedCursor === 'string' ? storedCursor : requestedNextCursor;
    const cursorHeld = actualCursor === since;

    const result = await processPendingRecordings(supabase, RECORDING_BATCH_SIZE);

    return NextResponse.json({
      ran: true,
      since,
      messagesSeen: messages.length,
      inserted,
      upsertFailed,
      truncated,
      stopReason,
      cursorHeld,
      ...result,
    });
  } catch (err) {
    if (isMissingTableError(err)) {
      return NextResponse.json({ ran: false, migrated: false, reason: 'Run migrations/2026-08-29-call-ingest.sql first.' });
    }
    console.error('Cron calls-sync failed:', err);
    return NextResponse.json({ ran: false, error: 'Sync failed.' }, { status: 500 });
  }
}
