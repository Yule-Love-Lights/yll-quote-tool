// Lists recently completed call messages from HighLevel's location-wide
// conversations export (calls_merge_plan_2026-08.md slice S2). Ported from
// the yll-call-copilot repo's src/lib/ghl/recordings.ts (master fb1bf326),
// adapted to reuse this repo's ghlFetch/HighLevelError instead of a second
// client. The listing shape is no longer a hypothesis: it was probed
// read-only against the live location on 2026-08-28/29 (see
// docs/context/ghl_transcript_probe_2026-08.md and this slice's PR body) —
// {messages, nextCursor, total, traceId}, with limit/sortBy/sortOrder/
// startDate/endDate accepted exactly as coded below.
//
// This module does NOT download audio or call Deepgram — decision 3 routes
// transcription through the HighLevel transcription endpoint instead (see
// transcribeHighLevel.ts). There is nothing to download here.

import { ghlFetch, HighLevelError } from '../integrations/highlevel';

const API_VERSION_HEADER = '2021-07-28';

// HighLevel's official location-wide export is cursor-paginated and accepts
// up to 1,000 messages per request (copilot's pinned constant, unchanged by
// the probe).
const EXPORT_PAGE_LIMIT = 1000;
const MAX_EXPORT_PAGES = 20;

export type GhlCallRecordingMessage = {
  messageId: string;
  conversationId: string;
  contactId: string | null;
  // The GHL staff user this call is attributed to — ground truth, straight
  // off the call message. See migration 2026-08-29-call-ingest.sql's header
  // for why this becomes call_transcripts.rep_ghl_user_id rather than
  // rep_email in this slice.
  userId: string | null;
  direction: 'inbound' | 'outbound' | null;
  dateAdded: string | null;
  durationSeconds: number | null;
};

type GhlMessage = {
  id: string;
  type?: string;
  messageType?: string;
  conversationId?: string;
  contactId?: string;
  userId?: string;
  direction?: string;
  dateAdded?: string;
  meta?: {
    call?: { status?: string; duration?: number };
    callStatus?: string;
    callDuration?: string | number;
  };
  callDuration?: number;
  callStatus?: string;
};

// Exported for tests — pure classification of one GHL message as a
// finished, recorded call. "completed" is GHL's documented terminal status
// for a finished call message; voicemail/no-answer/ringing carry no useful
// recording. Checks meta.callStatus AND meta.call.status (the probe found
// only meta.call.status present across 100 live sample messages, but the
// copilot's own dual check is kept defensively — see the probe notes in
// this slice's PR body).
export function isCompletedCallMessage(m: GhlMessage): boolean {
  const type = (m.messageType ?? m.type ?? '').toUpperCase();
  if (!type.includes('CALL')) return false;
  const status = (m.meta?.callStatus ?? m.meta?.call?.status ?? m.callStatus ?? '').toLowerCase();
  return status === 'completed';
}

// Exported for tests — pulls a call message's duration from whichever field
// shape the payload actually uses.
export function messageDuration(m: GhlMessage): number | null {
  const d = m.meta?.callDuration ?? m.meta?.call?.duration ?? m.callDuration;
  const parsed = typeof d === 'string' ? Number(d) : d;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

export type RecentCallRecordingsStopReason = 'window_exhausted' | 'result_limit' | 'provider_page_cap';

/**
 * `nextSince` is present only when every call through that exclusive instant
 * was returned. The caller may persist it and continue draining the same
 * window. A provider-page-cap result advances only through a timestamp
 * group that a later provider message proved complete.
 */
export type RecentCallRecordingsPage = {
  messages: GhlCallRecordingMessage[];
  truncated: boolean;
  stopReason: RecentCallRecordingsStopReason;
  nextSince: string | null;
};

export async function listRecentCallRecordings(
  sinceIso: string,
  limit = 100,
  untilIso = new Date().toISOString(),
): Promise<RecentCallRecordingsPage> {
  const since = new Date(sinceIso).getTime();
  const until = new Date(untilIso).getTime();
  if (!Number.isFinite(since) || !Number.isFinite(until) || until < since) {
    throw new HighLevelError('Invalid recording export window.');
  }

  if (!Number.isFinite(limit)) throw new HighLevelError('Invalid recording export limit.');
  const safeLimit = Math.max(1, Math.floor(limit));
  const results: GhlCallRecordingMessage[] = [];
  const seenProviderCursors = new Set<string>();
  let providerCursor: string | null = null;
  let lastSeenTime: number | null = null;
  let safeThroughTime: number | null = null;

  const locationId = requireLocationId();

  for (let pageNumber = 0; pageNumber < MAX_EXPORT_PAGES; pageNumber++) {
    const params = new URLSearchParams({
      locationId,
      channel: 'Call',
      limit: String(EXPORT_PAGE_LIMIT),
      sortBy: 'createdAt',
      sortOrder: 'asc',
      startDate: new Date(since).toISOString(),
      endDate: new Date(until).toISOString(),
    });
    if (providerCursor) params.set('cursor', providerCursor);

    const page = await ghlFetch<{ messages?: GhlMessage[]; nextCursor?: string | null }>(
      `/conversations/messages/export?${params}`,
      {},
      API_VERSION_HEADER,
    );
    const messages = page.messages ?? [];

    for (const m of messages) {
      const addedAt = m.dateAdded ? new Date(m.dateAdded).getTime() : Number.NaN;
      if (!Number.isFinite(addedAt)) {
        throw new HighLevelError('HighLevel export returned a message without a valid dateAdded.');
      }
      if (lastSeenTime !== null && addedAt < lastSeenTime) {
        throw new HighLevelError('HighLevel export violated the requested ascending date order.');
      }
      if (lastSeenTime !== null && addedAt > lastSeenTime) safeThroughTime = lastSeenTime;
      lastSeenTime = addedAt;

      if (addedAt < since || addedAt > until || !isCompletedCallMessage(m)) continue;
      if (!m.id || !m.conversationId) {
        throw new HighLevelError('HighLevel export returned a completed call without its required ids.');
      }
      results.push({
        messageId: m.id,
        conversationId: m.conversationId,
        contactId: m.contactId ?? null,
        userId: m.userId ?? null,
        direction: m.direction === 'inbound' || m.direction === 'outbound' ? m.direction : null,
        dateAdded: new Date(addedAt).toISOString(),
        durationSeconds: messageDuration(m),
      });
    }

    const ordered = results.sort((a, b) => {
      const byDate = new Date(a.dateAdded!).getTime() - new Date(b.dateAdded!).getTime();
      return byDate || a.messageId.localeCompare(b.messageId);
    });
    if (ordered.length > safeLimit) {
      const boundaryTime = new Date(ordered[safeLimit - 1].dateAdded!).getTime();
      // Seeing a later provider message, or exhausting the export, proves no
      // call sharing this boundary timestamp remains on an unseen page.
      if (lastSeenTime !== null && (lastSeenTime > boundaryTime || !page.nextCursor)) {
        const boundaryMessages = ordered.filter(message => new Date(message.dateAdded!).getTime() <= boundaryTime);
        return {
          messages: boundaryMessages,
          truncated: true,
          stopReason: 'result_limit',
          nextSince: new Date(boundaryTime + 1).toISOString(),
        };
      }
    }

    const nextProviderCursor = page.nextCursor ?? null;
    if (!nextProviderCursor) {
      return { messages: ordered, truncated: false, stopReason: 'window_exhausted', nextSince: null };
    }
    if (seenProviderCursors.has(nextProviderCursor)) {
      throw new HighLevelError('HighLevel export repeated a pagination cursor.');
    }
    seenProviderCursors.add(nextProviderCursor);
    providerCursor = nextProviderCursor;
  }

  // A hard page cap protects the Vercel function without creating a
  // liveness trap. Advance only through a timestamp group that a later raw
  // provider message proved complete; otherwise fail and keep the old cursor.
  if (safeThroughTime === null || safeThroughTime < since) {
    throw new HighLevelError('HighLevel export page cap reached without a safe continuation.');
  }
  const ordered = results
    .filter(message => new Date(message.dateAdded!).getTime() <= safeThroughTime)
    .sort((a, b) => {
      const byDate = new Date(a.dateAdded!).getTime() - new Date(b.dateAdded!).getTime();
      return byDate || a.messageId.localeCompare(b.messageId);
    });
  return {
    messages: ordered,
    truncated: true,
    stopReason: 'provider_page_cap',
    nextSince: new Date(safeThroughTime + 1).toISOString(),
  };
}

function requireLocationId(): string {
  const locationId = process.env.HIGHLEVEL_LOCATION_ID;
  if (!locationId) {
    throw new HighLevelError('HighLevel not configured. Set HIGHLEVEL_LOCATION_ID.');
  }
  return locationId;
}
