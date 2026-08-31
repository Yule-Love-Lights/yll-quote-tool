// Coverage for the one-off comment backfill: every real failure mode that
// matters for a script that writes to a live CRM once, by hand.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const createInternalCommentMock = vi.fn();
vi.mock('../integrations/highlevel', () => ({
  createInternalComment: (...args: unknown[]) => createInternalCommentMock(...args),
}));

import { backfillMissingComments, type CommentBackfillPreview } from './backfillComments';

type Update = { patch: Record<string, unknown>; filters: [string, unknown][] };

const NOW = new Date('2026-08-31T12:00:00.000Z');

function transcript(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    called_at: '2026-08-31T11:00:00.000Z', // 1 hour before NOW: not stale
    ghl_contact_id: 'contact-1',
    summary: 'Robert asked about roofline lighting.',
    customer_name: 'Robert Gelo',
    is_test: false,
    ...over,
  };
}

function fakeSupabase(
  transcripts: Record<string, unknown>[],
  commitmentsByTranscript: Record<string, { kind: string; detail: string; promised_at: string | null }[]> = {},
  opts: { failUpdate?: boolean } = {},
) {
  const updates: Update[] = [];
  const filters: [string, unknown[]][] = [];
  const from = vi.fn((table: string) => {
    if (table === 'call_transcripts') {
      const query = {
        not: (...args: unknown[]) => { filters.push(['not', args]); return query; },
        is: (...args: unknown[]) => { filters.push(['is', args]); return query; },
        order: () => query,
        limit: () => Promise.resolve({ data: transcripts, error: null }),
      };
      return {
        select: () => query,
        update: (patch: Record<string, unknown>) => {
          const record: Update = { patch, filters: [] };
          updates.push(record);
          const uq = {
            eq(column: string, value: unknown) {
              record.filters.push([column, value]);
              return uq;
            },
            then(resolve: (v: { data: null; error: unknown }) => void) {
              if (opts.failUpdate) return resolve({ data: null, error: { message: 'db down' } });
              resolve({ data: null, error: null });
            },
          };
          return uq;
        },
      };
    }
    if (table === 'call_commitments') {
      let transcriptId = '';
      const query = {
        eq(_col: string, value: unknown) { transcriptId = String(value); return query; },
        order: () => query,
        then(resolve: (v: { data: unknown; error: null }) => void) {
          resolve({ data: commitmentsByTranscript[transcriptId] ?? [], error: null });
        },
      };
      return { select: () => query };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  return { supabase: { from } as unknown as SupabaseClient, updates, filters };
}

beforeEach(() => {
  createInternalCommentMock.mockReset();
  createInternalCommentMock.mockResolvedValue({ conversationId: 'c', messageId: 'm' });
});

describe('backfillMissingComments', () => {
  it('only selects rows with a posted note and no comment yet', async () => {
    const { supabase, filters } = fakeSupabase([transcript()]);
    await backfillMissingComments(supabase, undefined, {}, NOW);
    expect(filters).toContainEqual(['not', ['ghl_note_posted_at', 'is', null]]);
    expect(filters).toContainEqual(['is', ['ghl_comment_posted_at', null]]);
  });

  it('posts the comment and records it', async () => {
    const { supabase, updates } = fakeSupabase(
      [transcript()],
      { t1: [{ kind: 'send_quote', detail: 'Send the proposal', promised_at: null }] },
    );

    const result = await backfillMissingComments(supabase, undefined, {}, NOW);

    expect(result).toEqual({ commented: 1, failed: 0, previewed: 0, skippedTest: 0, postedButNotRecorded: 0 });
    expect(createInternalCommentMock).toHaveBeenCalledTimes(1);
    const [contactId, body] = createInternalCommentMock.mock.calls[0];
    expect(contactId).toBe('contact-1');
    expect(body).toContain('Robert asked about roofline lighting.');
    expect(body).toContain('- Send the proposal');

    expect(updates).toHaveLength(1);
    expect(updates[0].patch).toHaveProperty('ghl_comment_posted_at');
    expect(updates[0].filters).toContainEqual(['id', 't1']);
  });

  it('one failing call does not stop the rest of the batch', async () => {
    createInternalCommentMock
      .mockRejectedValueOnce(new Error('HighLevel 500'))
      .mockResolvedValue({ conversationId: 'c', messageId: 'm' });
    const { supabase } = fakeSupabase([
      transcript({ id: 't1', ghl_contact_id: 'contact-1' }),
      transcript({ id: 't2', ghl_contact_id: 'contact-2' }),
    ]);

    const result = await backfillMissingComments(supabase, undefined, {}, NOW);

    expect(result.commented).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('never posts a comment for a test row, and counts it separately from an ordinary failure', async () => {
    // The candidate query should already exclude these, but this script does
    // not trust that upstream guarantee to hold forever.
    const { supabase, updates } = fakeSupabase([transcript({ is_test: true })]);
    const result = await backfillMissingComments(supabase, undefined, {}, NOW);
    expect(createInternalCommentMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(result.skippedTest).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('skips a row with no summary via its OWN named guard, not by crashing into the catch block', async () => {
    // A mutation probe on this file found that gutting the guard still
    // passed a looser version of this test: composeCallNote throws on a
    // null summary, and the outer catch reports the same result shape
    // (failed: 1) either way. Asserting the specific console message is
    // what actually distinguishes the deliberate skip from an accidental
    // crash landing in the same bucket.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase, updates } = fakeSupabase([transcript({ summary: null })]);

    const result = await backfillMissingComments(supabase, undefined, {}, NOW);

    expect(createInternalCommentMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(result.failed).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('missing summary or contact id'));
    errorSpy.mockRestore();
  });

  it('counts a comment that posted but could not be recorded SEPARATELY from an ordinary failure, and warns loudly against a blind re-run', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { supabase, updates } = fakeSupabase([transcript()], {}, { failUpdate: true });

    const result = await backfillMissingComments(supabase, undefined, {}, NOW);

    expect(createInternalCommentMock).toHaveBeenCalledTimes(1);
    expect(result.postedButNotRecorded).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.commented).toBe(0);
    expect(updates).toHaveLength(1); // the attempt was made even though it failed
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Do not re-run this script'),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it('prefixes an old call with its real date, so the comment does not read as if it just happened', async () => {
    const { supabase } = fakeSupabase([transcript({ called_at: '2026-08-20T14:00:00.000Z' })]); // 11 days before NOW
    await backfillMissingComments(supabase, undefined, {}, NOW);
    const [, body] = createInternalCommentMock.mock.calls[0];
    expect(body).toContain('this call happened on Aug 20, 2026');
  });

  it('a recent call gets no backdated prefix', async () => {
    const { supabase } = fakeSupabase([transcript()]); // 1 hour before NOW
    await backfillMissingComments(supabase, undefined, {}, NOW);
    const [, body] = createInternalCommentMock.mock.calls[0];
    expect(body).not.toContain('Backfilled');
  });

  it('dry run posts nothing and writes nothing, but hands back the real body and the customer name', async () => {
    const previews: CommentBackfillPreview[] = [];
    const { supabase, updates } = fakeSupabase(
      [transcript()],
      { t1: [{ kind: 'callback', detail: 'Call back tomorrow', promised_at: null }] },
    );

    const result = await backfillMissingComments(supabase, 10, {
      dryRun: true,
      onPreview: p => previews.push(p),
    }, NOW);

    expect(createInternalCommentMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(result).toEqual({ commented: 0, failed: 0, previewed: 1, skippedTest: 0, postedButNotRecorded: 0 });
    expect(previews[0].contactId).toBe('contact-1');
    expect(previews[0].customerName).toBe('Robert Gelo');
    expect(previews[0].body).toContain('- Call back tomorrow');
  });
});
