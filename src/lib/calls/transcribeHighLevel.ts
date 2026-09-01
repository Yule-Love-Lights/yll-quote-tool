// The HighLevel transcript adapter (calls_merge_plan_2026-08.md decision 3,
// slice S2). Deepgram is gone: this calls HighLevel's own transcription
// endpoint (proven working on the pinned 2021-07-28 API version -- see
// docs/context/ghl_transcript_probe_2026-08.md) and maps its sentence array
// into the same TranscribeResult/utterance shape the yll-call-copilot repo's
// src/lib/deepgram.ts produced, so flattenUtterances() and any future
// downstream consumer (S4's hard metrics, etc.) need no changes to read a
// call that came from HighLevel instead of Deepgram.
//
// Known gaps, from the probe: no confidence field in practice (the `words`
// arrays come back empty -- sentence granularity only), and which
// mediaChannel is the rep flips between inbound and outbound calls (spot-
// checked live during this slice's build on two real inbound calls -- see
// this slice's PR body). Neither matters for what this adapter stores: it
// never infers a role, only a stable per-call channel index.

import { ghlFetch, HighLevelError } from '../integrations/highlevel';

const API_VERSION_HEADER = '2021-07-28';

export type CallUtterance = {
  speaker: number;
  start: number;
  end: number;
  text: string;
};

export type TranscribeResult = {
  rawText: string;
  utterances: CallUtterance[];
  durationSeconds: number;
};

// Thrown when HighLevel has no transcript for a call (a 404/400
// "not found" response, or an empty sentence array). The pipeline catches
// this the same as any other per-recording failure -- it never aborts the
// batch (calls_merge_plan_2026-08.md's decision 3: "Calls where HighLevel
// has no transcript get marked failed with a reason, mirroring the existing
// per-recording failure convention").
export class HighLevelTranscriptUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HighLevelTranscriptUnavailableError';
  }
}

type HighLevelTranscriptSentence = {
  speaker?: number;
  mediaChannel?: number;
  sentenceIndex?: number;
  startTime?: number;
  endTime?: number;
  transcript?: string;
  words?: unknown[];
};

// Pure + exported for tests: turns the utterance array into the "Label:
// text" line shape the copilot's src/lib/deepgram.ts flattenUtterances
// already produced, one line per utterance, labeled "Speaker 0" / "Speaker
// 1" by channel index. Never guesses at "Rep:"/"Customer:" labels -- see
// this module's header for why. Rep identity for a call instead comes from
// the call message's ghl_user_id (ground truth), handled in pipeline.ts.
export function flattenUtterances(utterances: CallUtterance[]): string {
  return utterances
    .filter(u => u.text.trim().length > 0)
    .map(u => `Speaker ${u.speaker}: ${u.text.trim()}`)
    .join('\n\n');
}

function requireLocationId(): string {
  const locationId = process.env.HIGHLEVEL_LOCATION_ID;
  if (!locationId) {
    throw new HighLevelError('HighLevel not configured. Set HIGHLEVEL_LOCATION_ID.');
  }
  return locationId;
}

export async function fetchHighLevelTranscript(messageId: string): Promise<TranscribeResult> {
  const locationId = requireLocationId();

  let sentences: HighLevelTranscriptSentence[];
  try {
    sentences = await ghlFetch<HighLevelTranscriptSentence[]>(
      `/conversations/locations/${encodeURIComponent(locationId)}/messages/${encodeURIComponent(messageId)}/transcription`,
      {},
      API_VERSION_HEADER,
    );
  } catch (err) {
    // GHL answers a missing transcript with HTTP 400
    // (canonicalCode CONVERSATIONS_MSG_RECORDING_NOT_FOUND, confirmed live
    // during this slice's build) as well as a plain 404 in principle -- both
    // mean "no transcript", not "something is broken".
    if (err instanceof HighLevelError && (err.status === 400 || err.status === 404)) {
      throw new HighLevelTranscriptUnavailableError(
        `HighLevel has no transcript for message ${messageId} (status ${err.status}).`,
      );
    }
    throw err;
  }

  if (!Array.isArray(sentences) || sentences.length === 0) {
    throw new HighLevelTranscriptUnavailableError(`HighLevel returned an empty transcript for message ${messageId}.`);
  }

  // Sort defensively by sentenceIndex (falling back to startTime) -- every
  // live sample returned them already in order, but nothing in HighLevel's
  // docs guarantees it.
  const ordered = [...sentences].sort((a, b) => {
    const byIndex = (a.sentenceIndex ?? 0) - (b.sentenceIndex ?? 0);
    if (byIndex !== 0) return byIndex;
    return (a.startTime ?? 0) - (b.startTime ?? 0);
  });

  // Speaker index derived from mediaChannel, in first-seen order -- NOT the
  // sentence's own numeric `speaker` field (which matched mediaChannel-1 in
  // every call sampled during this slice's build, but deriving it ourselves
  // doesn't depend on that holding forever), and NOT a role label. Which
  // channel is the rep flips between inbound and outbound calls (confirmed
  // on two real inbound calls: channel 1 opened with the rep's greeting on
  // both, while the probe's sampled outbound call had channel 2 as the rep
  // -- see this slice's PR body). Role inference stays a documented S4
  // concern (calls_merge_plan_2026-08.md's Risks section), not this
  // adapter's job.
  const channelToSpeaker = new Map<number, number>();
  const utterances: CallUtterance[] = ordered.map(s => {
    const channel = s.mediaChannel ?? 0;
    if (!channelToSpeaker.has(channel)) channelToSpeaker.set(channel, channelToSpeaker.size);
    return {
      speaker: channelToSpeaker.get(channel)!,
      start: s.startTime ?? 0,
      end: s.endTime ?? 0,
      text: (s.transcript ?? '').trim(),
    };
  });

  const durationSeconds = Math.round(Math.max(0, ...utterances.map(u => u.end)));

  return {
    rawText: flattenUtterances(utterances),
    utterances,
    durationSeconds,
  };
}
