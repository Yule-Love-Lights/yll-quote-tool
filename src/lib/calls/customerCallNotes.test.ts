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
) {
  const filters: [string, unknown[]][] = [];
  const from = vi.fn((table: string) => {
    if (table === 'call_transcripts') {
      const query = {
        eq: (...args: unknown[]) => { filters.push(['eq', args]); return query; },
        not: (...args: unknown[]) => { filters.push(['not', args]); return query; },
        order: () => query,
        limit: () => Promise.resolve({ data: transcripts, error: null }),
      };
      return { select: () => query };
    }
    if (table === 'call_commitments') {
      let ids: string[] = [];
      const query = {
        in(_col: string, values: string[]) {
          ids = values;
          return query;
        },
        order: () => query,
        then(resolve: (v: { data: unknown; error: null }) => void) {
          const rows = ids.flatMap(id => (commitmentsByTranscript[id] ?? []).map(c => ({ ...c, transcript_id: id })));
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
  it('returns nothing without a fetch when there is no contact id', async () => {
    const supabase = fakeSupabase([]);
    const result = await listCallNotesForCustomer(supabase, null);
    expect(result).toEqual([]);
    expect((supabase.from as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('shapes a call with its tasks, newest call first (the query already orders; this proves the shape)', async () => {
    const supabase = fakeSupabase(
      [transcript({ id: 't1', called_at: '2026-08-22T14:00:00.000Z' })],
      { t1: [{ kind: 'send_quote', detail: 'Send the proposal', promised_at: null }] },
    );

    const result = await listCallNotesForCustomer(supabase, 'contact-1');

    expect((supabase as unknown as { filters: [string, unknown[]][] }).filters)
      .toContainEqual(['eq', ['ghl_contact_id', 'contact-1']]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      transcriptId: 't1',
      calledAt: '2026-08-22T14:00:00.000Z',
      summary: 'Robert asked about roofline lighting.',
      posted: true,
      tasks: [{ detail: 'Send the proposal', promisedAt: null }],
    });
  });

  it('filters out calls with no summary yet at the database, so the page never renders a blank card', async () => {
    // The shaping code trusts the query rather than re-filtering client-side
    // (Postgres already excludes null summaries), so this asserts the filter
    // the query actually sends.
    const supabase = fakeSupabase([transcript()]) as SupabaseClient & { filters: [string, unknown[]][] };
    await listCallNotesForCustomer(supabase, 'contact-1');
    expect(supabase.filters).toContainEqual(['not', ['summary', 'is', null]]);
  });

  it('marks a call whose note has not posted yet as not posted, without hiding it', async () => {
    const supabase = fakeSupabase([transcript({ ghl_note_posted_at: null })]);
    const result = await listCallNotesForCustomer(supabase, 'contact-1');
    expect(result[0].posted).toBe(false);
  });

  it('a call with no tasks gets an empty task list, not a missing field', async () => {
    const supabase = fakeSupabase([transcript()]);
    const result = await listCallNotesForCustomer(supabase, 'contact-1');
    expect(result[0].tasks).toEqual([]);
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
    expect(await getCallNotesForCustomer('contact-1')).toEqual([]);
  });

  it('returns an empty list, not an error, before this feature is migrated', async () => {
    getSupabaseServiceClientMock.mockReturnValue({
      from: () => ({ select: () => ({ eq: () => ({ not: () => ({ order: () => ({
        limit: () => Promise.reject(Object.assign(new Error('column "summary" does not exist'), { code: '42703' })),
      }) }) }) }) }),
    });
    expect(await getCallNotesForCustomer('contact-1')).toEqual([]);
  });
});
