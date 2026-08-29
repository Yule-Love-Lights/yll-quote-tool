// Coverage for countOfficeTasksForTranscript -- proves it reads the
// transcript's commitment ids and counts the matching office_tasks rows.
// This is a READ-ONLY reporting helper (fix round: the producer itself now
// runs inside call_commitments_finalize_extraction's own transaction, see
// migrations/2026-08-29-call-commitments.sql and this file's own header),
// so there is no RPC/mutation to test here, only the two reads and their
// composition.

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { countOfficeTasksForTranscript } from './produceTasks';

function fakeSupabase(opts: {
  commitmentIds: string[];
  commitmentError?: { message: string } | null;
  officeTaskCount: number | null;
  officeTaskError?: { message: string } | null;
}) {
  const officeTasksFilters: { column: string; value: unknown }[] = [];
  const from = vi.fn((table: string) => {
    if (table === 'call_commitments') {
      return {
        select: () => ({
          eq: async () => ({
            data: opts.commitmentError ? null : opts.commitmentIds.map(id => ({ id })),
            error: opts.commitmentError ?? null,
          }),
        }),
      };
    }
    if (table === 'office_tasks') {
      return {
        select: () => ({
          eq: (column: string, value: unknown) => {
            officeTasksFilters.push({ column, value });
            return {
              in: (column2: string, value2: unknown) => {
                officeTasksFilters.push({ column: column2, value: value2 });
                return Promise.resolve({
                  count: opts.officeTaskError ? null : opts.officeTaskCount,
                  error: opts.officeTaskError ?? null,
                });
              },
            };
          },
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  return { client: { from } as unknown as SupabaseClient, officeTasksFilters };
}

describe('countOfficeTasksForTranscript', () => {
  it('counts office_tasks rows matching the transcript\'s commitment ids', async () => {
    const { client, officeTasksFilters } = fakeSupabase({
      commitmentIds: ['c-1', 'c-2'],
      officeTaskCount: 2,
    });

    const result = await countOfficeTasksForTranscript(client, 't-1');

    expect(result).toBe(2);
    expect(officeTasksFilters).toEqual([
      { column: 'source_system', value: 'call_commitment' },
      { column: 'source_event_id', value: ['c-1', 'c-2'] },
    ]);
  });

  it('returns 0 without querying office_tasks when the transcript has no commitments', async () => {
    const { client } = fakeSupabase({ commitmentIds: [], officeTaskCount: 0 });
    const result = await countOfficeTasksForTranscript(client, 't-1');
    expect(result).toBe(0);
  });

  it('treats a null count as 0 rather than throwing', async () => {
    const { client } = fakeSupabase({ commitmentIds: ['c-1'], officeTaskCount: null });
    const result = await countOfficeTasksForTranscript(client, 't-1');
    expect(result).toBe(0);
  });

  it('throws on a commitment-read error', async () => {
    const { client } = fakeSupabase({
      commitmentIds: [],
      commitmentError: { message: 'boom' },
      officeTaskCount: 0,
    });
    await expect(countOfficeTasksForTranscript(client, 't-1')).rejects.toEqual({ message: 'boom' });
  });

  it('throws on an office_tasks-count read error', async () => {
    const { client } = fakeSupabase({
      commitmentIds: ['c-1'],
      officeTaskCount: null,
      officeTaskError: { message: 'boom' },
    });
    await expect(countOfficeTasksForTranscript(client, 't-1')).rejects.toEqual({ message: 'boom' });
  });
});
