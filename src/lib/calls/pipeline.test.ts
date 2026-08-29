// Coverage for the calls pipeline (calls_merge_plan_2026-08.md slice S2):
// the duration pre-check, the post-transcription junk guard, the happy
// path's writes, per-row failure isolation in the batch runner, and the
// compare-and-swap claim. Ported from the yll-call-copilot repo's
// src/lib/recordings/pipeline.test.ts (master fb1bf326), stripped of
// verticals/learnings/outcome-matching (out of scope for this slice) and
// Deepgram/download (replaced by fetchHighLevelTranscript). junk.ts is used
// for real (not mocked), same as the copilot's own test file.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const getContactMock = vi.fn();
const getGhlUserMock = vi.fn();
let highLevelConfigured = true;
vi.mock('../integrations/highlevel', () => ({
  getContact: (...args: unknown[]) => getContactMock(...args),
  getGhlUser: (...args: unknown[]) => getGhlUserMock(...args),
  isHighLevelConfigured: () => highLevelConfigured,
}));

const fetchHighLevelTranscriptMock = vi.fn();
vi.mock('./transcribeHighLevel', async () => {
  const actual = await vi.importActual<typeof import('./transcribeHighLevel')>('./transcribeHighLevel');
  return {
    ...actual,
    fetchHighLevelTranscript: (...args: unknown[]) => fetchHighLevelTranscriptMock(...args),
  };
});

import { claimRecording, processOneRecording, processPendingRecordings, type RepIdentityCache } from './pipeline';

type RowState = { status: string; processing_at: string | null };

type Row = {
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

function baseRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'r1',
    ghl_message_id: 'm1',
    ghl_contact_id: 'c1',
    ghl_user_id: 'u1',
    direction: 'inbound',
    called_at: '2026-07-10T12:00:00.000Z',
    duration_seconds: 120,
    status: 'pending',
    processing_at: null,
    ...overrides,
  };
}

// Fake Supabase client covering the two tables pipeline.ts touches:
// call_recordings (select for the batch, update for status writes and for
// the claim compare-and-swap) and call_transcripts (insert).
//
// `rowState` is an OPTIONAL shared, mutable map standing in for the real
// row's live status/processing_at in the database -- see the copilot's own
// test file for the full rationale (concurrent-claim modeling).
function fakeSupabase(
  opts: {
    pendingRows?: Row[];
    transcriptInsertError?: { message: string } | null;
    rowState?: Map<string, RowState>;
    insertCallsSink?: Record<string, unknown>[];
  } = {},
) {
  const updateCalls: { id: string; patch: Record<string, unknown> }[] = [];
  const insertCalls = opts.insertCallsSink ?? [];

  const from = vi.fn((table: string) => {
    if (table === 'call_recordings') {
      return {
        select: () => ({
          or: () => ({
            order: () => ({
              limit: async () => ({ data: opts.pendingRows ?? [], error: null }),
            }),
          }),
        }),
        update: (patch: Record<string, unknown>) => {
          const filters: { id?: string; status?: string; processingAtLt?: string } = {};
          const builder = {
            eq(column: string, value: string) {
              if (column === 'id') filters.id = value;
              if (column === 'status') filters.status = value;
              return builder;
            },
            lt(column: string, value: string) {
              if (column === 'processing_at') filters.processingAtLt = value;
              return builder;
            },
            select: async () => {
              const id = filters.id!;
              updateCalls.push({ id, patch });
              if (!opts.rowState) return { data: [{ id }], error: null };
              const current = opts.rowState.get(id);
              let matches = !!current;
              if (matches && filters.status !== undefined) matches = current!.status === filters.status;
              if (matches && filters.processingAtLt !== undefined) {
                matches = current!.processing_at != null && current!.processing_at < filters.processingAtLt;
              }
              if (matches) opts.rowState.set(id, { ...current!, ...(patch as Partial<RowState>) });
              return matches ? { data: [{ id }], error: null } : { data: [], error: null };
            },
            then(resolve: (v: { error: null }) => void) {
              const id = filters.id!;
              updateCalls.push({ id, patch });
              if (opts.rowState) {
                const current = opts.rowState.get(id) ?? { status: 'pending', processing_at: null };
                opts.rowState.set(id, { ...current, ...(patch as Partial<RowState>) });
              }
              resolve({ error: null });
            },
          };
          return builder;
        },
      };
    }
    if (table === 'call_transcripts') {
      return {
        insert: (row: Record<string, unknown>) => ({
          select: () => ({
            single: async () => {
              insertCalls.push(row);
              if (opts.transcriptInsertError) return { data: null, error: opts.transcriptInsertError };
              return { data: { id: 'tr1' }, error: null };
            },
          }),
        }),
      };
    }
    throw new Error(`Unexpected table in test: ${table}`);
  });

  return { client: { from } as unknown as SupabaseClient, updateCalls, insertCalls };
}

describe('processOneRecording', () => {
  beforeEach(() => {
    highLevelConfigured = true;
    getContactMock.mockReset().mockResolvedValue({ phone: '5551234567', email: 'jamie@example.com', fullName: 'Jamie Lee' });
    getGhlUserMock.mockReset().mockResolvedValue({ email: 'rep@x.com', name: 'Jane Rep' });
    fetchHighLevelTranscriptMock.mockReset().mockResolvedValue({
      rawText: 'Speaker 0: hi there this is a real conversation about holiday lights for your home this season.\n\nSpeaker 1: great, tell me more about pricing and scheduling please.',
      utterances: [
        { speaker: 0, start: 0, end: 3, text: 'hi there this is a real conversation about holiday lights for your home this season' },
        { speaker: 1, start: 3, end: 6, text: 'great, tell me more about pricing and scheduling please' },
      ],
      durationSeconds: 120,
    });
  });

  it('skips recordings shorter than 20 seconds without calling the transcript adapter', async () => {
    const { client, updateCalls } = fakeSupabase();
    const row = baseRow({ duration_seconds: 10 });

    const result = await processOneRecording(client, row);

    expect(result).toBe('skipped');
    expect(fetchHighLevelTranscriptMock).not.toHaveBeenCalled();
    expect(updateCalls).toEqual([{ id: 'r1', patch: { status: 'skipped', skip_reason: 'duration_under_20s' } }]);
  });

  it('fails immediately with no ghl_message_id', async () => {
    const { client, updateCalls } = fakeSupabase();
    const row = baseRow({ ghl_message_id: null });

    const result = await processOneRecording(client, row);

    expect(result).toBe('failed');
    expect(fetchHighLevelTranscriptMock).not.toHaveBeenCalled();
    expect(updateCalls[0].patch.status).toBe('failed');
  });

  it('fails without calling the transcript adapter when HighLevel is not configured', async () => {
    highLevelConfigured = false;
    const { client } = fakeSupabase();

    const result = await processOneRecording(client, baseRow());

    expect(result).toBe('failed');
    expect(fetchHighLevelTranscriptMock).not.toHaveBeenCalled();
  });

  it('skips a transcribed call the junk detector rejects (e.g. single-speaker voicemail)', async () => {
    fetchHighLevelTranscriptMock.mockResolvedValueOnce({
      rawText: 'Speaker 0: please leave a message after the tone.',
      utterances: [{ speaker: 0, start: 0, end: 2, text: 'please leave a message after the tone' }],
      durationSeconds: 30,
    });
    const { client, updateCalls } = fakeSupabase();

    const result = await processOneRecording(client, baseRow());

    expect(result).toBe('skipped');
    expect(updateCalls).toEqual([{ id: 'r1', patch: { status: 'skipped', skip_reason: 'single_speaker' } }]);
  });

  it('marks a per-recording failure with a clear reason when HighLevel has no transcript, without aborting', async () => {
    const { HighLevelTranscriptUnavailableError } = await import('./transcribeHighLevel');
    fetchHighLevelTranscriptMock.mockRejectedValueOnce(
      new HighLevelTranscriptUnavailableError('HighLevel has no transcript for message m1 (status 400).'),
    );
    const { client, updateCalls } = fakeSupabase();

    const result = await processOneRecording(client, baseRow());

    expect(result).toBe('failed');
    expect(updateCalls).toEqual([
      { id: 'r1', patch: { status: 'failed', detail: { error: 'HighLevel has no transcript for message m1 (status 400).' } } },
    ]);
  });

  it('transcribes a real call end to end: inserts the transcript row and marks the recording transcribed', async () => {
    const { client, updateCalls, insertCalls } = fakeSupabase();

    const result = await processOneRecording(client, baseRow());

    expect(result).toBe('transcribed');
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0]).toMatchObject({
      source: 'ghl:m1',
      customer_phone: '5551234567',
      customer_name: 'Jamie Lee',
      ghl_contact_id: 'c1',
      rep_ghl_user_id: 'u1',
      direction: 'inbound',
      duration_seconds: 120,
    });
    // rep_email/rep_name resolved via getGhlUser (rep-assignment ruling).
    expect(insertCalls[0]).toMatchObject({ rep_email: 'rep@x.com', rep_name: 'Jane Rep' });
    expect(updateCalls).toEqual([{ id: 'r1', patch: { status: 'transcribed', transcript_id: 'tr1' } }]);
  });

  it('degrades rep_email/rep_name to null on a GHL user-lookup failure, without failing the recording', async () => {
    getGhlUserMock.mockResolvedValueOnce({ email: null, name: null });
    const { client, insertCalls } = fakeSupabase();

    const result = await processOneRecording(client, baseRow());

    expect(result).toBe('transcribed');
    expect(insertCalls[0]).toMatchObject({ rep_email: null, rep_name: null });
  });

  it('resolves rep_email/rep_name to null (no lookup attempted) when the recording has no ghl_user_id', async () => {
    const { client, insertCalls } = fakeSupabase();

    const result = await processOneRecording(client, baseRow({ ghl_user_id: null }));

    expect(result).toBe('transcribed');
    expect(insertCalls[0]).toMatchObject({ rep_email: null, rep_name: null });
    expect(getGhlUserMock).not.toHaveBeenCalled();
  });

  it('caches a rep identity lookup across multiple recordings sharing a ghl_user_id within one run', async () => {
    const cache: RepIdentityCache = new Map();
    const { client } = fakeSupabase();

    await processOneRecording(client, baseRow({ id: 'r1' }), cache);
    await processOneRecording(client, baseRow({ id: 'r2' }), cache);

    expect(getGhlUserMock).toHaveBeenCalledTimes(1);
  });

  it('rounds a fractional adapter duration to an integer for the call_transcripts insert', async () => {
    fetchHighLevelTranscriptMock.mockResolvedValueOnce({
      rawText: 'Speaker 0: hi there this is a real conversation about holiday lights for your home this season.\n\nSpeaker 1: great, tell me more about pricing and scheduling please.',
      utterances: [
        { speaker: 0, start: 0, end: 3, text: 'hi there this is a real conversation about holiday lights for your home this season' },
        { speaker: 1, start: 3, end: 6, text: 'great, tell me more about pricing and scheduling please' },
      ],
      durationSeconds: 96.6,
    });
    const { client, insertCalls } = fakeSupabase();

    const result = await processOneRecording(client, baseRow());

    expect(result).toBe('transcribed');
    expect(insertCalls[0].duration_seconds).toBe(97);
  });

  it('stores a readable error detail when a thrown failure is a plain object, not an Error', async () => {
    // Regression class from the copilot: the first live failures stored
    // "[object Object]" because String() was applied to a thrown Supabase
    // error object.
    fetchHighLevelTranscriptMock.mockRejectedValueOnce({ code: '22P02', message: 'invalid input syntax for type integer' });
    const { client, updateCalls } = fakeSupabase();

    const result = await processOneRecording(client, baseRow());

    expect(result).toBe('failed');
    const detail = updateCalls[0].patch.detail as { error: string };
    expect(detail.error).toContain('22P02');
    expect(detail.error).not.toBe('[object Object]');
  });

  it('degrades customer fields to null on a GHL contact hydrate failure, without failing the recording', async () => {
    getContactMock.mockRejectedValueOnce(new Error('contact not found'));
    const { client, insertCalls } = fakeSupabase();

    const result = await processOneRecording(client, baseRow());

    expect(result).toBe('transcribed');
    expect(insertCalls[0]).toMatchObject({ customer_phone: null, customer_name: null });
  });
});

describe('processPendingRecordings', () => {
  beforeEach(() => {
    highLevelConfigured = true;
    getContactMock.mockReset().mockResolvedValue({ phone: null, email: null, fullName: null });
    getGhlUserMock.mockReset().mockResolvedValue({ email: null, name: null });
    fetchHighLevelTranscriptMock.mockReset();
  });

  it('shares one rep-identity cache across the whole batch: two rows with the same ghl_user_id resolve it only once', async () => {
    fetchHighLevelTranscriptMock.mockResolvedValue({
      rawText: 'Speaker 0: hello and welcome to yule love lights how can I help you today with your display.\n\nSpeaker 1: I would like a quote for my house please.',
      utterances: [
        { speaker: 0, start: 0, end: 3, text: 'hello and welcome to yule love lights how can I help you today with your display' },
        { speaker: 1, start: 3, end: 6, text: 'I would like a quote for my house please' },
      ],
      durationSeconds: 90,
    });
    getGhlUserMock.mockResolvedValue({ email: 'rep@x.com', name: 'Jane Rep' });

    const rows: Row[] = [baseRow({ id: 'r1', ghl_user_id: 'u1' }), baseRow({ id: 'r2', ghl_user_id: 'u1' })];
    const { client } = fakeSupabase({ pendingRows: rows });

    const result = await processPendingRecordings(client, 6);

    expect(result).toEqual({ done: 2, skipped: 0, failed: 0 });
    expect(getGhlUserMock).toHaveBeenCalledTimes(1);
  });

  it('returns all-zero counts with no pending rows', async () => {
    const { client } = fakeSupabase({ pendingRows: [] });

    const result = await processPendingRecordings(client, 6);

    expect(result).toEqual({ done: 0, skipped: 0, failed: 0 });
  });

  it('processes each pending row independently: one failure does not stop the rest', async () => {
    fetchHighLevelTranscriptMock
      .mockRejectedValueOnce(new Error('HighLevel down')) // r1 fails
      .mockResolvedValueOnce({
        rawText: 'Speaker 0: hello and welcome to yule love lights how can I help you today with your display.\n\nSpeaker 1: I would like a quote for my house please.',
        utterances: [
          { speaker: 0, start: 0, end: 3, text: 'hello and welcome to yule love lights how can I help you today with your display' },
          { speaker: 1, start: 3, end: 6, text: 'I would like a quote for my house please' },
        ],
        durationSeconds: 90,
      });

    const rows: Row[] = [baseRow({ id: 'r1' }), baseRow({ id: 'r2' })];
    const { client } = fakeSupabase({ pendingRows: rows });

    const result = await processPendingRecordings(client, 6);

    expect(result).toEqual({ done: 1, skipped: 0, failed: 1 });
  });

  it('a second concurrent batch skips a row the first already claimed, and never double-transcribes it', async () => {
    fetchHighLevelTranscriptMock.mockResolvedValue({
      rawText: 'Speaker 0: hello and welcome to yule love lights how can I help you today with your display.\n\nSpeaker 1: I would like a quote for my house please.',
      utterances: [
        { speaker: 0, start: 0, end: 3, text: 'hello and welcome to yule love lights how can I help you today with your display' },
        { speaker: 1, start: 3, end: 6, text: 'I would like a quote for my house please' },
      ],
      durationSeconds: 90,
    });

    const rows: Row[] = [baseRow({ id: 'r1' })];
    const rowState = new Map<string, RowState>([['r1', { status: 'pending', processing_at: null }]]);
    const sharedInsertCalls: Record<string, unknown>[] = [];

    const clientA = fakeSupabase({ pendingRows: rows, rowState, insertCallsSink: sharedInsertCalls }).client;
    const clientB = fakeSupabase({ pendingRows: rows, rowState, insertCallsSink: sharedInsertCalls }).client;

    const [resultA, resultB] = await Promise.all([processPendingRecordings(clientA, 6), processPendingRecordings(clientB, 6)]);

    expect(resultA.done + resultB.done).toBe(1);
    expect(resultA.skipped + resultB.skipped).toBe(0);
    expect(resultA.failed + resultB.failed).toBe(0);
    expect(sharedInsertCalls).toHaveLength(1);
    expect(rowState.get('r1')?.status).toBe('transcribed');
  });

  it('reclaims and fully processes a candidate row left abandoned in processing (crashed invocation)', async () => {
    fetchHighLevelTranscriptMock.mockResolvedValue({
      rawText: 'Speaker 0: hello and welcome to yule love lights how can I help you today with your display.\n\nSpeaker 1: I would like a quote for my house please.',
      utterances: [
        { speaker: 0, start: 0, end: 3, text: 'hello and welcome to yule love lights how can I help you today with your display' },
        { speaker: 1, start: 3, end: 6, text: 'I would like a quote for my house please' },
      ],
      durationSeconds: 90,
    });

    const staleRow = baseRow({ id: 'r1', status: 'processing', processing_at: '2026-07-14T11:00:00.000Z' }); // 60 min old
    const rowState = new Map<string, RowState>([['r1', { status: 'processing', processing_at: '2026-07-14T11:00:00.000Z' }]]);
    const { client } = fakeSupabase({ pendingRows: [staleRow], rowState });

    const result = await processPendingRecordings(client, 6, new Date('2026-07-14T12:00:00.000Z'));

    expect(result).toEqual({ done: 1, skipped: 0, failed: 0 });
    expect(rowState.get('r1')?.status).toBe('transcribed');
  });
});

describe('claimRecording', () => {
  it('claims a pending row via compare-and-swap', async () => {
    const rowState = new Map<string, RowState>([['r1', { status: 'pending', processing_at: null }]]);
    const { client } = fakeSupabase({ rowState });

    const claimed = await claimRecording(client, { id: 'r1', status: 'pending' }, new Date('2026-07-14T12:00:00.000Z'));

    expect(claimed).toBe(true);
    expect(rowState.get('r1')).toEqual({ status: 'processing', processing_at: '2026-07-14T12:00:00.000Z' });
  });

  it('fails to claim a row a concurrent invocation already claimed', async () => {
    const rowState = new Map<string, RowState>([['r1', { status: 'processing', processing_at: '2026-07-14T11:59:00.000Z' }]]);
    const { client } = fakeSupabase({ rowState });

    const claimed = await claimRecording(client, { id: 'r1', status: 'pending' }, new Date('2026-07-14T12:00:00.000Z'));

    expect(claimed).toBe(false);
  });

  it('reclaims a processing row abandoned more than 15 minutes ago', async () => {
    const rowState = new Map<string, RowState>([['r1', { status: 'processing', processing_at: '2026-07-14T11:40:00.000Z' }]]); // 20 min old
    const { client } = fakeSupabase({ rowState });

    const claimed = await claimRecording(client, { id: 'r1', status: 'processing' }, new Date('2026-07-14T12:00:00.000Z'));

    expect(claimed).toBe(true);
    expect(rowState.get('r1')).toEqual({ status: 'processing', processing_at: '2026-07-14T12:00:00.000Z' });
  });

  it('does not reclaim a processing row still inside the 15-minute staleness window', async () => {
    const rowState = new Map<string, RowState>([['r1', { status: 'processing', processing_at: '2026-07-14T11:50:00.000Z' }]]); // 10 min old
    const { client } = fakeSupabase({ rowState });

    const claimed = await claimRecording(client, { id: 'r1', status: 'processing' }, new Date('2026-07-14T12:00:00.000Z'));

    expect(claimed).toBe(false);
  });
});
