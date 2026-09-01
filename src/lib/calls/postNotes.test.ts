// Coverage for the post-call HighLevel note worker. Supabase, the
// summariser and the HighLevel client are all mocked; the note composer
// runs FOR REAL so what these tests assert about a body is what a staff
// member would actually read.
//
// The failure modes pinned here are the ones that can hurt: a second note
// for the same call, a test row reaching the live CRM, a call with no
// contact, a HighLevel outage mid-batch, and a summariser failure leaving a
// half-written row behind.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const summarizeCallMock = vi.fn();
vi.mock('./summarize', () => ({
  summarizeCall: (...args: unknown[]) => summarizeCallMock(...args),
  SUMMARY_MODEL: 'test-summary-model',
  TerminalSummaryError: class TerminalSummaryError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'TerminalSummaryError';
    }
  },
}));

const createContactNoteMock = vi.fn();
const createInternalCommentMock = vi.fn();
vi.mock('../integrations/highlevel', () => ({
  createContactNote: (...args: unknown[]) => createContactNoteMock(...args),
  createInternalComment: (...args: unknown[]) => createInternalCommentMock(...args),
  isHighLevelConfigured: () => true,
}));

import { postPendingCallNotes, noteIdFrom, CALL_NOTE_MAX_ATTEMPTS } from './postNotes';
import type { NoteCandidate } from './postNotes';

type Update = { patch: Record<string, unknown>; filters: [string, unknown][] };

function candidate(over: Partial<NoteCandidate> = {}): NoteCandidate {
  return {
    id: 'transcript-1',
    raw_text: 'Speaker 0: hello\n\nSpeaker 1: hi there',
    called_at: '2026-08-26T17:00:00.000Z',
    ghl_contact_id: 'contact-1',
    is_test: false,
    summary: null,
    ghl_note_attempts: 0,
    ...over,
  };
}

function fakeSupabase(
  rows: NoteCandidate[],
  commitments: Record<string, { kind: string; detail: string; promised_at: string | null }[]> = {},
  opts: {
    claimWins?: boolean;
    failUpdateWhen?: (patch: Record<string, unknown>) => boolean;
    commitmentsError?: { code: string };
  } = {},
) {
  const updates: Update[] = [];
  const claimWins = opts.claimWins ?? true;

  const from = vi.fn((table: string) => {
    if (table === 'call_commitments') {
      let transcriptId = '';
      const query = {
        eq(_column: string, value: unknown) {
          transcriptId = String(value);
          return query;
        },
        order() {
          return query;
        },
        then(resolve: (value: { data: unknown; error: unknown }) => void) {
          if (opts.commitmentsError) return resolve({ data: null, error: opts.commitmentsError });
          resolve({ data: commitments[transcriptId] ?? [], error: null });
        },
      };
      return { select: () => query };
    }

    return {
      select: () => {
        const query = {
          is: () => query,
          not: () => query,
          or: () => query,
          order: () => query,
          limit: (n: number) => Promise.resolve({ data: rows.slice(0, n), error: null }),
        };
        return query;
      },
      update: (patch: Record<string, unknown>) => {
        const record: Update = { patch, filters: [] };
        updates.push(record);
        const query = {
          eq(column: string, value: unknown) {
            record.filters.push([column, value]);
            return query;
          },
          is(column: string, value: unknown) {
            record.filters.push([column, value]);
            return query;
          },
          select() {
            // Only the claim calls .select(); a lost race returns no rows.
            return Promise.resolve({ data: claimWins ? [{ id: 'claimed' }] : [], error: null });
          },
          then(
            resolve: (value: { data: null; error: unknown }) => void,
            reject?: (reason: unknown) => void,
          ) {
            if (opts.failUpdateWhen?.(patch)) {
              // patchRow throws on a returned error, so model the real shape.
              return resolve({ data: null, error: { message: 'db down' } });
            }
            void reject;
            resolve({ data: null, error: null });
          },
        };
        return query;
      },
    };
  });

  return { supabase: { from } as unknown as SupabaseClient, updates };
}

function patchesWith(updates: Update[], key: string): Update[] {
  return updates.filter(u => Object.prototype.hasOwnProperty.call(u.patch, key));
}

beforeEach(() => {
  summarizeCallMock.mockReset();
  createContactNoteMock.mockReset();
  createInternalCommentMock.mockReset();
  summarizeCallMock.mockResolvedValue('Customer asked for a price on roofline lights.');
  createContactNoteMock.mockResolvedValue({ id: 'note-1' });
  createInternalCommentMock.mockResolvedValue({ conversationId: 'conv-1', messageId: 'msg-1' });
});

describe('noteIdFrom', () => {
  // Six real notes posted to production with a null id because the first cut
  // only read the bare shape. The id is what makes a bad batch enumerable and
  // therefore deletable, so every wrapper HighLevel might use is accepted.
  it('reads the id whether HighLevel returns it bare or wrapped', () => {
    expect(noteIdFrom({ id: 'bare' })).toBe('bare');
    expect(noteIdFrom({ note: { id: 'wrapped' } })).toBe('wrapped');
    expect(noteIdFrom({ notes: [{ id: 'listed' }] })).toBe('listed');
  });

  it('returns null rather than a wrong value when there is no id to read', () => {
    expect(noteIdFrom(null)).toBeNull();
    expect(noteIdFrom(undefined)).toBeNull();
    expect(noteIdFrom({})).toBeNull();
    expect(noteIdFrom({ note: {} })).toBeNull();
    expect(noteIdFrom({ notes: [] })).toBeNull();
    expect(noteIdFrom({ id: 42 })).toBeNull();
    expect(noteIdFrom({ id: '' })).toBeNull();
  });
});

describe('postPendingCallNotes', () => {
  it('posts one note carrying the summary and the tasks, then marks the row posted', async () => {
    const { supabase, updates } = fakeSupabase([candidate()], {
      'transcript-1': [
        { kind: 'send_quote', detail: 'Send the proposal by email', promised_at: null },
      ],
    });

    const result = await postPendingCallNotes(supabase, 6);

    expect(result.posted).toBe(1);
    expect(createContactNoteMock).toHaveBeenCalledTimes(1);
    const [contactId, body] = createContactNoteMock.mock.calls[0];
    expect(contactId).toBe('contact-1');
    expect(body).toContain('Customer asked for a price on roofline lights.');
    expect(body).toContain('- Send the proposal by email');

    const posted = patchesWith(updates, 'ghl_note_posted_at');
    expect(posted).toHaveLength(1);
    expect(posted[0].patch.ghl_note_id).toBe('note-1');
  });

  it('also posts an internal comment carrying the same body, and records it', async () => {
    const { supabase, updates } = fakeSupabase([candidate()], {
      'transcript-1': [{ kind: 'send_quote', detail: 'Send the proposal', promised_at: null }],
    });

    await postPendingCallNotes(supabase, 6);

    expect(createInternalCommentMock).toHaveBeenCalledTimes(1);
    const [contactId, message] = createInternalCommentMock.mock.calls[0];
    expect(contactId).toBe('contact-1');
    expect(message).toContain('- Send the proposal');
    expect(patchesWith(updates, 'ghl_comment_posted_at')).toHaveLength(1);
  });

  it('retries the comment marker write once when the comment itself posted fine', async () => {
    // S85 wrap finding: createInternalComment and its marker write used to
    // share one try/catch, so a transient DB blip on JUST the marker write
    // (the comment already succeeded in HighLevel) fell into the same log
    // path as an actual comment-post failure and left ghl_comment_posted_at
    // null forever -- which the backfill script would later read as
    // "note posted, comment missing" and post a SECOND comment. One retry
    // is enough to recover from a one-off blip.
    let markerAttempts = 0;
    const { supabase, updates } = fakeSupabase([candidate()], undefined, {
      failUpdateWhen: patch => {
        if (!('ghl_comment_posted_at' in patch)) return false;
        markerAttempts++;
        return markerAttempts === 1; // fail once, succeed on the retry
      },
    });

    const result = await postPendingCallNotes(supabase, 6);

    expect(createInternalCommentMock).toHaveBeenCalledTimes(1); // never re-posted the comment itself
    expect(markerAttempts).toBe(2);
    expect(patchesWith(updates, 'ghl_comment_posted_at')).toHaveLength(2); // the failed try + the retry
    expect(result.posted).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('gives up after a second failed comment marker write, without touching the note or crashing the batch', async () => {
    const { supabase, updates } = fakeSupabase([candidate()], undefined, {
      failUpdateWhen: patch => 'ghl_comment_posted_at' in patch, // always fails
    });

    const result = await postPendingCallNotes(supabase, 6);

    expect(createInternalCommentMock).toHaveBeenCalledTimes(1);
    expect(patchesWith(updates, 'ghl_note_posted_at')).toHaveLength(1); // the note itself is unaffected
    expect(result.posted).toBe(1);
    expect(result.failed).toBe(0); // best-effort: an unrecorded comment never fails the call
  });

  it('never posts the comment before the note exists', async () => {
    // Ordering matters: the comment references the same content as the
    // note, and there is no reason for it to exist without the note.
    const callOrder: string[] = [];
    createContactNoteMock.mockImplementationOnce(async () => {
      callOrder.push('note');
      return { id: 'note-1' };
    });
    createInternalCommentMock.mockImplementationOnce(async () => {
      callOrder.push('comment');
      return { conversationId: 'c', messageId: 'm' };
    });
    const { supabase } = fakeSupabase([candidate()]);

    await postPendingCallNotes(supabase, 6);

    expect(callOrder).toEqual(['note', 'comment']);
  });

  it('a failed comment does not block the note, does not fail the call, and is not retried', async () => {
    // Best-effort by design: the note is the durable record. Retrying the
    // comment on the next batch would require re-selecting a call whose
    // note already posted, which the candidate query structurally excludes.
    createInternalCommentMock.mockRejectedValueOnce(new Error('HighLevel 500'));
    const { supabase, updates } = fakeSupabase([candidate()]);

    const result = await postPendingCallNotes(supabase, 6);

    expect(result.posted).toBe(1);
    expect(result.failed).toBe(0);
    expect(patchesWith(updates, 'ghl_note_posted_at')).toHaveLength(1);
    expect(patchesWith(updates, 'ghl_comment_posted_at')).toHaveLength(0);
  });

  it('never posts a comment in dry run', async () => {
    const { supabase } = fakeSupabase([candidate()]);
    await postPendingCallNotes(supabase, 3, new Date(), { dryRun: true });
    expect(createInternalCommentMock).not.toHaveBeenCalled();
  });

  it('stores the note id from the shape HighLevel actually returns', async () => {
    // The live response wraps the created note. Reading the bare shape is
    // what put six untraceable notes into the CRM.
    createContactNoteMock.mockResolvedValueOnce({ note: { id: 'ghl-note-99' } });
    const { supabase, updates } = fakeSupabase([candidate()]);

    await postPendingCallNotes(supabase, 6);

    expect(patchesWith(updates, 'ghl_note_posted_at')[0].patch.ghl_note_id).toBe('ghl-note-99');
  });

  it('still posts a note for a call that produced no tasks', async () => {
    const { supabase } = fakeSupabase([candidate()], {});
    const result = await postPendingCallNotes(supabase, 6);
    expect(result.posted).toBe(1);
    expect(createContactNoteMock.mock.calls[0][1]).toContain('No follow-up tasks came out of this call.');
  });

  it('never posts a note for a test row, and takes it out of the queue', async () => {
    const { supabase, updates } = fakeSupabase([candidate({ is_test: true })]);
    const result = await postPendingCallNotes(supabase, 6);

    expect(createContactNoteMock).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(patchesWith(updates, 'ghl_note_skip_reason')[0].patch.ghl_note_skip_reason).toBe('is_test');
  });

  it('never posts a note for a call with no contact, and takes it out of the queue', async () => {
    const { supabase, updates } = fakeSupabase([candidate({ ghl_contact_id: null })]);
    const result = await postPendingCallNotes(supabase, 6);

    expect(createContactNoteMock).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(patchesWith(updates, 'ghl_note_skip_reason')[0].patch.ghl_note_skip_reason).toBe('no_contact_id');
  });

  it('claims the row with the attempt count as the compare-and-swap token', async () => {
    const { supabase, updates } = fakeSupabase([candidate({ ghl_note_attempts: 2 })]);
    await postPendingCallNotes(supabase, 6);

    const claim = patchesWith(updates, 'ghl_note_claimed_at')[0];
    expect(claim.patch.ghl_note_attempts).toBe(3);
    expect(claim.filters).toContainEqual(['ghl_note_attempts', 2]);
    expect(claim.filters).toContainEqual(['ghl_note_posted_at', null]);
  });

  it('posts nothing when another worker already claimed the row', async () => {
    const { supabase } = fakeSupabase([candidate()], {}, { claimWins: false });
    const result = await postPendingCallNotes(supabase, 6);

    expect(createContactNoteMock).not.toHaveBeenCalled();
    expect(result.posted).toBe(0);
    expect(result.contended).toBe(1);
  });

  it('reuses a summary that already exists rather than paying for a second one', async () => {
    const { supabase, updates } = fakeSupabase([candidate({ summary: 'Already summarised.' })]);
    await postPendingCallNotes(supabase, 6);

    expect(summarizeCallMock).not.toHaveBeenCalled();
    expect(patchesWith(updates, 'summary')).toHaveLength(0);
    expect(createContactNoteMock.mock.calls[0][1]).toContain('Already summarised.');
  });

  it('leaves no half-written row when the summariser fails', async () => {
    summarizeCallMock.mockRejectedValue(new Error('model timeout'));
    const { supabase, updates } = fakeSupabase([candidate()]);

    const result = await postPendingCallNotes(supabase, 6);

    expect(result.failed).toBe(1);
    expect(createContactNoteMock).not.toHaveBeenCalled();
    expect(patchesWith(updates, 'summary')).toHaveLength(0);
    expect(patchesWith(updates, 'ghl_note_posted_at')).toHaveLength(0);
    expect(patchesWith(updates, 'ghl_note_last_failure_code')[0].patch.ghl_note_last_failure_code)
      .toBe('summary_failed');
  });

  it('records a HighLevel failure without marking the call posted', async () => {
    createContactNoteMock.mockRejectedValue(new Error('HighLevel 500'));
    const { supabase, updates } = fakeSupabase([candidate()]);

    const result = await postPendingCallNotes(supabase, 6);

    expect(result.failed).toBe(1);
    expect(patchesWith(updates, 'ghl_note_posted_at')).toHaveLength(0);
    expect(patchesWith(updates, 'ghl_note_last_failure_code')[0].patch.ghl_note_last_failure_code)
      .toBe('highlevel_post_failed');
    expect(patchesWith(updates, 'ghl_note_quarantined_at')).toHaveLength(0);
  });

  it('quarantines a call that has failed its last allowed attempt', async () => {
    createContactNoteMock.mockRejectedValue(new Error('HighLevel 500'));
    const { supabase, updates } = fakeSupabase([
      candidate({ ghl_note_attempts: CALL_NOTE_MAX_ATTEMPTS - 1 }),
    ]);

    const result = await postPendingCallNotes(supabase, 6);

    expect(result.quarantined).toBe(1);
    expect(patchesWith(updates, 'ghl_note_quarantined_at')).toHaveLength(1);
  });

  it('one failing call does not stop the rest of the batch', async () => {
    createContactNoteMock
      .mockRejectedValueOnce(new Error('HighLevel 500'))
      .mockResolvedValue({ id: 'note-2' });
    const { supabase } = fakeSupabase([
      candidate({ id: 'transcript-1' }),
      candidate({ id: 'transcript-2', ghl_contact_id: 'contact-2' }),
    ]);

    const result = await postPendingCallNotes(supabase, 6);

    expect(result.failed).toBe(1);
    expect(result.posted).toBe(1);
  });

  it('a failed skip write does not abort the rest of the batch', async () => {
    // Before the fix round this write was the one mutating call outside a
    // try/catch, so a transient database error on a test row took the whole
    // batch down with it.
    const { supabase } = fakeSupabase(
      [candidate({ id: 'transcript-1', is_test: true }), candidate({ id: 'transcript-2' })],
      {},
      { failUpdateWhen: patch => 'ghl_note_skip_reason' in patch },
    );

    const result = await postPendingCallNotes(supabase, 6);

    expect(result.failed).toBe(1);
    expect(result.posted).toBe(1);
    expect(createContactNoteMock).toHaveBeenCalledTimes(1);
  });

  it('quarantines a note it posted but could not record, rather than posting it twice', async () => {
    // The note already exists in the CRM at this point. Retrying would put a
    // second copy on a real customer's record, so the row is taken out of
    // the queue instead.
    const { supabase, updates } = fakeSupabase([candidate()], {}, {
      failUpdateWhen: patch => 'ghl_note_posted_at' in patch,
    });

    const result = await postPendingCallNotes(supabase, 6);

    expect(createContactNoteMock).toHaveBeenCalledTimes(1);
    expect(result.posted).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.quarantined).toBe(1);
    const quarantine = patchesWith(updates, 'ghl_note_quarantined_at')[0];
    expect(quarantine.patch.ghl_note_last_failure_code).toBe('posted_marker_failed');
  });

  it('labels a commitments read failure as one, not as a summary failure', async () => {
    const { supabase, updates } = fakeSupabase([candidate()], {}, {
      commitmentsError: { code: '42P01' },
    });

    const result = await postPendingCallNotes(supabase, 6);

    expect(result.failed).toBe(1);
    expect(createContactNoteMock).not.toHaveBeenCalled();
    expect(patchesWith(updates, 'ghl_note_last_failure_code')[0].patch.ghl_note_last_failure_code)
      .toBe('commitments_read_failed');
  });

  it('dry run writes nothing even for a row it would skip', async () => {
    // The skip branch has its own write, so the dry-run guard has to hold
    // there too. Found by a mutation probe: removing that guard failed no
    // test, because the dry-run case above never reaches this branch.
    const { supabase, updates } = fakeSupabase([candidate({ is_test: true })]);

    const result = await postPendingCallNotes(supabase, 3, new Date(), { dryRun: true });

    expect(updates).toHaveLength(0);
    expect(createContactNoteMock).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
  });

  it('dry run writes nothing, posts nothing, and hands back the real body', async () => {
    const previews: { contactId: string; body: string }[] = [];
    const { supabase, updates } = fakeSupabase([candidate()], {
      'transcript-1': [{ kind: 'callback', detail: 'Call back tomorrow', promised_at: null }],
    });

    const result = await postPendingCallNotes(supabase, 3, new Date(), {
      dryRun: true,
      onPreview: preview => previews.push(preview),
    });

    expect(createContactNoteMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    expect(result.posted).toBe(0);
    expect(result.previewed).toBe(1);
    expect(previews[0].contactId).toBe('contact-1');
    expect(previews[0].body).toContain('- Call back tomorrow');
  });
});
