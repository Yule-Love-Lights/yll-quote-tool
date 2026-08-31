// Coverage for listCallNotesForCustomer: the pure shaping of a customer's
// call summaries + tasks for the /customers/[contactId] profile page
// (Naldo's ask, 2026-08-30 — "make the customer notes also show up in
// their customer profile in the quote tool"). Supabase is mocked; the
// ordering and shaping is what a real database row would drive.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

function fakeSupabase(
  transcripts: Record<string, unknown>[],
  commitmentsByTranscript: Record<string, Record<string, unknown>[]> = {},
  taskStatusByCommitmentId: Record<string, string> = {},
) {
  const filters: [string, unknown[]][] = [];
  const from = vi.fn((table: string) => {
    if (table === 'call_transcripts') {
      const query = {
        eq: (...args: unknown[]) => { filters.push(['eq', args]); return query; },
        in: (...args: unknown[]) => { filters.push(['in', args]); return query; },
        not: (...args: unknown[]) => { filters.push(['not', args]); return query; },
        order: () => query,
        limit: () => Promise.resolve({ data: transcripts, error: null }),
      };
      return { select: () => query };
    }
    if (table === 'call_commitments') {
      let transcriptIds: string[] = [];
      const query = {
        in(_col: string, values: string[]) {
          transcriptIds = values;
          return query;
        },
        order: () => query,
        then(resolve: (v: { data: unknown; error: null }) => void) {
          const rows = transcriptIds.flatMap(id =>
            (commitmentsByTranscript[id] ?? []).map(c => ({ ...c, transcript_id: id })));
          resolve({ data: rows, error: null });
        },
      };
      return { select: () => query };
    }
    if (table === 'office_tasks') {
      let commitmentIds: string[] = [];
      const query = {
        eq: () => query,
        in(_col: string, values: string[]) {
          commitmentIds = values;
          return query;
        },
        then(resolve: (v: { data: unknown; error: null }) => void) {
          const rows = commitmentIds
            .filter(id => id in taskStatusByCommitmentId)
            .map(id => ({ source_event_id: id, status: taskStatusByCommitmentId[id] }));
          resolve({ data: rows, error: null });
        },
      };
      return { select: () => query };
    }
    throw new Error(`Unexpected table: ${table}`);
  });
  return { from: from as unknown as SupabaseClient['from'], filters } as unknown as SupabaseClient & { filters: typeof filters };
}

function transcript(over: Record<string, unknown> = {}) {
  return {
    id: 't1',
    called_at: '2026-08-22T14:21:18.403Z',
    summary: 'Robert asked about roofline lighting.',
    ghl_note_posted_at: '2026-08-22T15:00:00.000Z',
    ghl_note_quarantined_at: null,
    ...over,
  };
}

const getSupabaseServiceClientMock = vi.fn();
const getSupabaseClientMock = vi.fn();
vi.mock('../supabase', () => ({
  getSupabaseServiceClient: (...args: unknown[]) => getSupabaseServiceClientMock(...args),
  getSupabaseClient: (...args: unknown[]) => getSupabaseClientMock(...args),
}));

import { listCallNotesForCustomer, getCallNotesForCustomer } from './customerCallNotes';

describe('listCallNotesForCustomer', () => {
  it('returns nothing without a fetch when there are no contact ids', async () => {
    const supabase = fakeSupabase([]);
    const result = await listCallNotesForCustomer(supabase, []);
    expect(result).toEqual([]);
    expect((supabase.from as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('queries every distinct contact id, deduplicated, so a customer whose quotes carry two HL ids is not missing history', async () => {
    const supabase = fakeSupabase([transcript()]);
    await listCallNotesForCustomer(supabase, ['contact-1', 'contact-2', 'contact-1']);
    expect(supabase.filters).toContainEqual(['in', ['ghl_contact_id', ['contact-1', 'contact-2']]]);
  });

  it('shapes a call with its tasks, newest call first (the query already orders; this proves the shape)', async () => {
    const supabase = fakeSupabase(
      [transcript({ id: 't1', called_at: '2026-08-22T14:00:00.000Z' })],
      { t1: [{ id: 'c1', kind: 'send_quote', detail: 'Send the proposal', promised_at: null }] },
    );

    const result = await listCallNotesForCustomer(supabase, ['contact-1']);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      transcriptId: 't1',
      calledAt: '2026-08-22T14:00:00.000Z',
      summary: 'Robert asked about roofline lighting.',
      noteStatus: 'posted',
      tasks: [{ detail: 'Send the proposal', promisedAt: null, status: null }],
    });
  });

  it('filters out calls with no summary yet at the database, so the page never renders a blank card', async () => {
    // The shaping code trusts the query rather than re-filtering client-side
    // (Postgres already excludes null summaries), so this asserts the filter
    // the query actually sends.
    const supabase = fakeSupabase([transcript()]);
    await listCallNotesForCustomer(supabase, ['contact-1']);
    expect(supabase.filters).toContainEqual(['not', ['summary', 'is', null]]);
  });

  it('marks a call still waiting on the hourly cron as pending, without hiding it', async () => {
    const supabase = fakeSupabase([transcript({ ghl_note_posted_at: null, ghl_note_quarantined_at: null })]);
    const result = await listCallNotesForCustomer(supabase, ['contact-1']);
    expect(result[0].noteStatus).toBe('pending');
  });

  it('marks a call whose note permanently failed as quarantined, DISTINCT from one still pending', async () => {
    // Staff-lens MED: both used to read ghl_note_posted_at as null and show
    // an identical badge, so a permanently broken call looked exactly like
    // one that just hadn't been picked up by the cron yet.
    const supabase = fakeSupabase([transcript({
      ghl_note_posted_at: null,
      ghl_note_quarantined_at: '2026-08-30T00:00:00.000Z',
    })]);
    const result = await listCallNotesForCustomer(supabase, ['contact-1']);
    expect(result[0].noteStatus).toBe('quarantined');
  });

  it('a call with no tasks gets an empty task list, not a missing field', async () => {
    const supabase = fakeSupabase([transcript()]);
    const result = await listCallNotesForCustomer(supabase, ['contact-1']);
    expect(result[0].tasks).toEqual([]);
  });

  it('reads the REAL office_tasks status for a task, not a static bullet', async () => {
    // Staff-lens HIGH: the first cut read call_commitments directly and a
    // task marked Completed on the real Tasks page kept showing here
    // forever with no indication anything had changed.
    const supabase = fakeSupabase(
      [transcript({ id: 't1' })],
      { t1: [
        { id: 'c1', detail: 'Call back tomorrow', promised_at: null },
        { id: 'c2', detail: 'Send the invoice', promised_at: null },
      ] },
      { c1: 'completed', c2: 'open' },
    );

    const result = await listCallNotesForCustomer(supabase, ['contact-1']);

    expect(result[0].tasks).toEqual([
      { detail: 'Call back tomorrow', promisedAt: null, status: 'completed' },
      { detail: 'Send the invoice', promisedAt: null, status: 'open' },
    ]);
  });

  it('a commitment with no matching office_tasks row reads as an unknown status, not a thrown error', async () => {
    const supabase = fakeSupabase(
      [transcript({ id: 't1' })],
      { t1: [{ id: 'c1', detail: 'Call back tomorrow', promised_at: null }] },
      {}, // no office_tasks row for c1
    );
    const result = await listCallNotesForCustomer(supabase, ['contact-1']);
    expect(result[0].tasks[0].status).toBeNull();
  });
});

describe('getCallNotesForCustomer', () => {
  beforeEach(() => {
    getSupabaseServiceClientMock.mockReset();
    getSupabaseClientMock.mockReset();
  });

  it('returns an empty list, not an error, when Supabase is unconfigured', async () => {
    getSupabaseServiceClientMock.mockReturnValue(null);
    getSupabaseClientMock.mockReturnValue(null);
    expect(await getCallNotesForCustomer(['contact-1'])).toEqual([]);
  });

  it('returns an empty list, not an error, before this feature is migrated', async () => {
    getSupabaseServiceClientMock.mockReturnValue({
      from: () => ({ select: () => ({ in: () => ({ not: () => ({ order: () => ({
        limit: () => Promise.reject(Object.assign(new Error('column "summary" does not exist'), { code: '42703' })),
      }) }) }) }) }),
    });
    expect(await getCallNotesForCustomer(['contact-1'])).toEqual([]);
  });
});
