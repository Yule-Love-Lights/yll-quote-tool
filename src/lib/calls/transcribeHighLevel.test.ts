// Coverage for the HighLevel transcript adapter (calls_merge_plan_2026-08.md
// decision 3, slice S2). The fixture shape mirrors the probe facts exactly
// (see docs/context/ghl_transcript_probe_2026-08.md and this slice's PR
// body): sentence objects carrying mediaChannel, speaker, sentenceIndex,
// startTime/endTime in seconds, transcript, and an empty words array.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ghlFetchMock = vi.fn();
vi.mock('../integrations/highlevel', async () => {
  const actual = await vi.importActual<typeof import('../integrations/highlevel')>('../integrations/highlevel');
  return {
    ...actual,
    ghlFetch: (...args: unknown[]) => ghlFetchMock(...args),
  };
});

import { HighLevelError } from '../integrations/highlevel';
import { fetchHighLevelTranscript, flattenUtterances, HighLevelTranscriptUnavailableError } from './transcribeHighLevel';

describe('flattenUtterances', () => {
  it('labels each utterance by numeric speaker index and drops empty text', () => {
    const text = flattenUtterances([
      { speaker: 0, start: 0, end: 1, text: 'hello there' },
      { speaker: 1, start: 1, end: 2, text: '' },
      { speaker: 1, start: 2, end: 3, text: 'hi' },
    ]);
    expect(text).toBe('Speaker 0: hello there\n\nSpeaker 1: hi');
  });
});

describe('fetchHighLevelTranscript', () => {
  beforeEach(() => {
    process.env.HIGHLEVEL_API_KEY = 'test-key';
    process.env.HIGHLEVEL_LOCATION_ID = 'test-location';
    ghlFetchMock.mockReset();
  });

  it('calls the pinned transcription endpoint for the given location and message', async () => {
    ghlFetchMock.mockResolvedValueOnce([
      { speaker: 0, mediaChannel: 1, sentenceIndex: 0, startTime: 0, endTime: 1, transcript: 'hi', words: [] },
    ]);

    await fetchHighLevelTranscript('msg-1');

    expect(ghlFetchMock).toHaveBeenCalledWith(
      '/conversations/locations/test-location/messages/msg-1/transcription',
      {},
      '2021-07-28',
    );
  });

  it('derives the speaker index from mediaChannel in first-seen order, not the raw speaker field', async () => {
    // mediaChannel 2 appears first here -- it must become speaker 0, and
    // mediaChannel 1 (seen second) becomes speaker 1, regardless of what the
    // sentence's own `speaker` field says. This is the inbound-vs-outbound
    // channel flip found during this slice's live spot check.
    ghlFetchMock.mockResolvedValueOnce([
      { speaker: 1, mediaChannel: 2, sentenceIndex: 0, startTime: 0, endTime: 1, transcript: 'first channel two', words: [] },
      { speaker: 0, mediaChannel: 1, sentenceIndex: 1, startTime: 1, endTime: 2, transcript: 'then channel one', words: [] },
      { speaker: 1, mediaChannel: 2, sentenceIndex: 2, startTime: 2, endTime: 3, transcript: 'channel two again', words: [] },
    ]);

    const result = await fetchHighLevelTranscript('msg-1');

    expect(result.utterances).toEqual([
      { speaker: 0, start: 0, end: 1, text: 'first channel two' },
      { speaker: 1, start: 1, end: 2, text: 'then channel one' },
      { speaker: 0, start: 2, end: 3, text: 'channel two again' },
    ]);
  });

  it('sorts sentences by sentenceIndex before flattening, even if the API returns them out of order', async () => {
    ghlFetchMock.mockResolvedValueOnce([
      { speaker: 1, mediaChannel: 2, sentenceIndex: 1, startTime: 1, endTime: 2, transcript: 'second', words: [] },
      { speaker: 0, mediaChannel: 1, sentenceIndex: 0, startTime: 0, endTime: 1, transcript: 'first', words: [] },
    ]);

    const result = await fetchHighLevelTranscript('msg-1');

    expect(result.rawText).toBe('Speaker 0: first\n\nSpeaker 1: second');
  });

  it('computes durationSeconds as the rounded max end time across all sentences', async () => {
    ghlFetchMock.mockResolvedValueOnce([
      { speaker: 0, mediaChannel: 1, sentenceIndex: 0, startTime: 0, endTime: 12.3, transcript: 'hi', words: [] },
      { speaker: 1, mediaChannel: 2, sentenceIndex: 1, startTime: 12, endTime: 96.6, transcript: 'bye', words: [] },
    ]);

    const result = await fetchHighLevelTranscript('msg-1');

    expect(result.durationSeconds).toBe(97);
  });

  it('throws HighLevelTranscriptUnavailableError on an empty sentence array', async () => {
    ghlFetchMock.mockResolvedValueOnce([]);

    await expect(fetchHighLevelTranscript('msg-1')).rejects.toBeInstanceOf(HighLevelTranscriptUnavailableError);
  });

  it('throws HighLevelTranscriptUnavailableError when HighLevel 400s with "recording not found" (observed live)', async () => {
    ghlFetchMock.mockRejectedValueOnce(
      new HighLevelError('HighLevel GET /transcription -> 400: not found', 400, '{"canonicalCode":"CONVERSATIONS_MSG_RECORDING_NOT_FOUND"}'),
    );

    await expect(fetchHighLevelTranscript('msg-1')).rejects.toBeInstanceOf(HighLevelTranscriptUnavailableError);
  });

  it('throws HighLevelTranscriptUnavailableError on a plain 404', async () => {
    ghlFetchMock.mockRejectedValueOnce(new HighLevelError('not found', 404));

    await expect(fetchHighLevelTranscript('msg-1')).rejects.toBeInstanceOf(HighLevelTranscriptUnavailableError);
  });

  it('never converts an unrelated failure (e.g. a 500 or timeout) into "unavailable" -- that would hide a real outage as a normal skip', async () => {
    ghlFetchMock.mockRejectedValueOnce(new HighLevelError('server error', 500));

    await expect(fetchHighLevelTranscript('msg-1')).rejects.not.toBeInstanceOf(HighLevelTranscriptUnavailableError);
  });

  it('refuses a missing HIGHLEVEL_LOCATION_ID before ever calling ghlFetch', async () => {
    delete process.env.HIGHLEVEL_LOCATION_ID;

    await expect(fetchHighLevelTranscript('msg-1')).rejects.toThrow(/HIGHLEVEL_LOCATION_ID/);
    expect(ghlFetchMock).not.toHaveBeenCalled();
  });
});
