// Coverage for backfillCommitments -- the batch entry point that runs
// call_transcripts through the extractor, persist, and THE PRODUCER. Mocks
// extraction/persist/produce; no live Supabase/Claude calls. Ported from the
// yll-call-copilot repo's src/lib/commitments/backfill.test.ts (master
// fb1bf326), adapted: table is call_transcripts (not transcripts), no
// metric_scope anywhere, extractRawCommitments takes no verticalName, and
// every successful-fresh-finalize case now also asserts THE PRODUCER
// (produceOfficeTasksFromCommitments) is called and its count folded into
// the result's new tasksCreated field.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

const extractRawCommitmentsMock = vi.fn();
vi.mock('./extract', () => ({
  extractRawCommitments: (...args: unknown[]) => extractRawCommitmentsMock(...args),
  EXTRACT_MODEL: 'test-extractor-v1',
  isTerminalCommitmentExtractionError: (error: unknown) =>
    error instanceof Error && error.name === 'TerminalCommitmentExtractionError',
}));

const persistCommitmentsMock = vi.fn();
vi.mock('./persist', () => ({
  persistCommitments: (...args: unknown[]) => persistCommitmentsMock(...args),
}));

const produceOfficeTasksFromCommitmentsMock = vi.fn();
vi.mock('./produceTasks', () => ({
  produceOfficeTasksFromCommitments: (...args: unknown[]) => produceOfficeTasksFromCommitmentsMock(...args),
}));

import { backfillCommitments, selectBackfillCandidates } from './backfill';
import type { BackfillCandidate } from './backfill';

function fakeSupabase(transcripts: BackfillCandidate[]) {
  const scopeFilters: [string, unknown][] = [];
  const nullFilters: string[] = [];
  const rpc = vi.fn().mockResolvedValue({ data: 'retry_scheduled', error: null });
  const from = vi.fn((table: string) => {
    if (table === 'call_transcripts') {
      return {
        select: () => {
          let attemptFilter: 'fresh' | 'retry' | null = null;
          const query = {
            is(column: string) {
              nullFilters.push(column);
              if (column === 'commitment_extraction_last_attempt_at') attemptFilter = 'fresh';
              return query;
            },
            not(column: string) {
              if (column === 'commitment_extraction_last_attempt_at') attemptFilter = 'retry';
              return query;
            },
            eq(column: string, value: unknown) {
              scopeFilters.push([column, value]);
              return query;
            },
            order() {
              return query;
            },
            limit(value: number) {
              const filtered = transcripts.filter(candidate =>
                attemptFilter === 'retry'
                  ? candidate.commitment_extraction_last_attempt_at !== null
                  : attemptFilter === 'fresh'
                    ? candidate.commitment_extraction_last_attempt_at === null
                    : true);
              return Promise.resolve({ data: filtered.slice(0, value), error: null });
            },
          };
          return query;
        },
      };
    }
    throw new Error(`Unexpected table in test: ${table}`);
  });
  return {
    client: { from, rpc } as unknown as SupabaseClient,
    nullFilters,
    rpc,
    scopeFilters,
  };
}

const t1: BackfillCandidate = { id: 't1', raw_text: 'Rep: hi.', called_at: '2026-01-15T18:30:00Z', commitment_extraction_last_attempt_at: null, rep_email: 'rep@x.com', ghl_contact_id: 'g1' };
const t2: BackfillCandidate = { id: 't2', raw_text: 'Rep: hello.', called_at: '2026-01-14T18:30:00Z', commitment_extraction_last_attempt_at: null, rep_email: null, ghl_contact_id: null };

describe('selectBackfillCandidates', () => {
  it('drops candidates that already have a commitment row, keeps the rest, caps at limit', () => {
    const result = selectBackfillCandidates([t1, t2], new Set(['t1']), 10);
    expect(result).toEqual([t2]);
  });

  it('caps at limit even when nothing has been extracted yet', () => {
    const result = selectBackfillCandidates([t1, t2], new Set(), 1);
    expect(result).toEqual([t2]);
  });

  it('reserves one retry slot while newer unattempted work continues', () => {
    const retry = {
      ...t1,
      id: 'retry',
      commitment_extraction_last_attempt_at: '2026-08-18T10:00:00Z',
    };
    const result = selectBackfillCandidates([retry, t1, t2], new Set(), 2);

    expect(result.map(candidate => candidate.id)).toEqual(['t2', 'retry']);
  });
});

describe('backfillCommitments', () => {
  beforeEach(() => {
    extractRawCommitmentsMock.mockReset().mockResolvedValue([]);
    persistCommitmentsMock.mockReset().mockResolvedValue({ ok: true, alreadyFinalized: false });
    produceOfficeTasksFromCommitmentsMock.mockReset().mockResolvedValue({ attempted: 0, created: 0 });
  });

  it('extracts and persists for each candidate transcript not already processed, no verticalName passed', async () => {
    const { client: supabase } = fakeSupabase([t2]);

    const result = await backfillCommitments(supabase, 10);

    expect(extractRawCommitmentsMock).toHaveBeenCalledTimes(1);
    expect(extractRawCommitmentsMock).toHaveBeenCalledWith(t2.raw_text);
    expect(persistCommitmentsMock).toHaveBeenCalledTimes(1);
    expect(persistCommitmentsMock).toHaveBeenCalledWith(supabase, 't2', null, null, [], 'test-extractor-v1');
    expect(result).toEqual({ done: 1, skipped: 0, failed: 0, refused: 0, quarantined: 0, tasksCreated: 0 });
  });

  it('a transcript with zero commitments still counts as done, not failed, and calls the producer (which creates zero tasks)', async () => {
    extractRawCommitmentsMock.mockResolvedValue([]);
    const { client: supabase } = fakeSupabase([t1]);

    const result = await backfillCommitments(supabase, 10);

    expect(produceOfficeTasksFromCommitmentsMock).toHaveBeenCalledWith(supabase, 't1');
    expect(result).toEqual({ done: 1, skipped: 0, failed: 0, refused: 0, quarantined: 0, tasksCreated: 0 });
  });

  it('THE PRODUCER runs after a fresh finalize and its created count is folded into tasksCreated', async () => {
    produceOfficeTasksFromCommitmentsMock.mockResolvedValueOnce({ attempted: 2, created: 2 });
    const { client: supabase } = fakeSupabase([t1]);

    const result = await backfillCommitments(supabase, 10);

    expect(produceOfficeTasksFromCommitmentsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ done: 1, skipped: 0, failed: 0, refused: 0, quarantined: 0, tasksCreated: 2 });
  });

  it('does NOT run the producer on an already-finalized outcome -- no new open commitment rows were written', async () => {
    persistCommitmentsMock.mockResolvedValueOnce({ ok: true, alreadyFinalized: true });
    const { client: supabase } = fakeSupabase([t1]);

    const result = await backfillCommitments(supabase, 10);

    expect(produceOfficeTasksFromCommitmentsMock).not.toHaveBeenCalled();
    expect(result).toEqual({ done: 0, skipped: 1, failed: 0, refused: 0, quarantined: 0, tasksCreated: 0 });
  });

  it('does NOT run the producer on a refused persist -- the guard against relabeling a settled commitment', async () => {
    persistCommitmentsMock.mockResolvedValueOnce({ ok: false, reason: 'has_resolved_commitments' });
    const { client: supabase } = fakeSupabase([t1]);

    const result = await backfillCommitments(supabase, 10);

    expect(produceOfficeTasksFromCommitmentsMock).not.toHaveBeenCalled();
    expect(result).toEqual({ done: 0, skipped: 0, failed: 0, refused: 1, quarantined: 0, tasksCreated: 0 });
  });

  it('counts a failed extraction without stopping the batch, and never calls the producer for it', async () => {
    extractRawCommitmentsMock.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([]);
    const { client: supabase, rpc } = fakeSupabase([t1, t2]);

    const result = await backfillCommitments(supabase, 10);

    expect(rpc).toHaveBeenCalledWith('record_commitment_extraction_failure', {
      p_transcript_id: 't2',
      p_failure_code: 'transient_dependency_failed',
    });
    expect(result).toEqual({ done: 1, skipped: 0, failed: 1, refused: 0, quarantined: 0, tasksCreated: 0 });
  });

  it('counts a persist refusal separately from done/failed, without stopping the batch', async () => {
    persistCommitmentsMock
      .mockResolvedValueOnce({ ok: false, reason: 'has_resolved_commitments' })
      .mockResolvedValueOnce({ ok: true, alreadyFinalized: false });
    const { client: supabase } = fakeSupabase([t1, t2]);

    const result = await backfillCommitments(supabase, 10);

    expect(result).toEqual({ done: 1, skipped: 0, failed: 0, refused: 1, quarantined: 0, tasksCreated: 0 });
  });

  it('counts a transcript finalized by a concurrent worker as skipped', async () => {
    persistCommitmentsMock.mockResolvedValueOnce({ ok: true, alreadyFinalized: true });
    const { client: supabase } = fakeSupabase([t1]);

    const result = await backfillCommitments(supabase, 10);

    expect(result).toEqual({ done: 0, skipped: 1, failed: 0, refused: 0, quarantined: 0, tasksCreated: 0 });
  });

  it('returns all-zero when there are no candidate transcripts', async () => {
    const { client: supabase } = fakeSupabase([]);

    const result = await backfillCommitments(supabase, 10);

    expect(result).toEqual({ done: 0, skipped: 0, failed: 0, refused: 0, quarantined: 0, tasksCreated: 0 });
  });

  it('asks the database for only unprocessed transcripts so rows older than the newest 200 cannot starve', async () => {
    const oldUnprocessed = { ...t2, id: 'older-than-window' };
    const { client, nullFilters } = fakeSupabase([oldUnprocessed]);

    const result = await backfillCommitments(client, 1);

    expect(nullFilters).toContain('commitments_extracted_at');
    expect(nullFilters).toContain('commitment_extraction_quarantined_at');
    expect(extractRawCommitmentsMock).toHaveBeenCalledWith(oldUnprocessed.raw_text);
    expect(result.done).toBe(1);
  });

  it('quarantine counter math: three deterministic failures in a row -- each attempt increments attempts and terminal_failures, the third crosses the quarantine threshold', async () => {
    const terminal = new Error('invalid structured output');
    terminal.name = 'TerminalCommitmentExtractionError';
    extractRawCommitmentsMock.mockRejectedValue(terminal);
    const { client, rpc } = fakeSupabase([t1]);

    rpc.mockResolvedValueOnce({ data: 'retry_scheduled', error: null });
    let result = await backfillCommitments(client, 1);
    expect(result).toEqual({ done: 0, skipped: 0, failed: 1, refused: 0, quarantined: 0, tasksCreated: 0 });

    rpc.mockResolvedValueOnce({ data: 'retry_scheduled', error: null });
    result = await backfillCommitments(client, 1);
    expect(result).toEqual({ done: 0, skipped: 0, failed: 1, refused: 0, quarantined: 0, tasksCreated: 0 });

    rpc.mockResolvedValueOnce({ data: 'quarantined', error: null });
    result = await backfillCommitments(client, 1);
    expect(rpc).toHaveBeenLastCalledWith('record_commitment_extraction_failure', {
      p_transcript_id: 't1',
      p_failure_code: 'deterministic_extraction_failed',
    });
    expect(result).toEqual({ done: 0, skipped: 0, failed: 1, refused: 0, quarantined: 1, tasksCreated: 0 });
  });

  it('treats a success race as skipped instead of recording a false failure', async () => {
    extractRawCommitmentsMock.mockRejectedValue(new Error('temporary provider failure'));
    const { client, rpc } = fakeSupabase([t1]);
    rpc.mockResolvedValue({ data: 'already_finalized', error: null });

    const result = await backfillCommitments(client, 1);

    expect(result).toEqual({ done: 0, skipped: 1, failed: 0, refused: 0, quarantined: 0, tasksCreated: 0 });
  });

  it('fails the whole job visibly when durable failure recording fails', async () => {
    extractRawCommitmentsMock.mockRejectedValue(new Error('temporary provider failure'));
    const { client, rpc } = fakeSupabase([t1]);
    rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });

    await expect(backfillCommitments(client, 1)).rejects.toEqual({
      code: 'PGRST202',
    });
  });
});
