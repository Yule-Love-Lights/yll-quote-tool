// Coverage for produceOfficeTasksFromCommitments -- proves it reads the
// transcript's OPEN commitments and calls the producer RPC once per id,
// tolerating a single commitment's failure without aborting the batch. The
// RPC's own idempotency (office_tasks' (source_system, source_event_id)
// unique index -- a second call for the same commitment returns the SAME
// existing task id rather than creating a duplicate) lives in
// migrations/2026-08-29-call-commitments.sql and cannot run under vitest;
// this file proves the TS wrapper's call shape and counting, not the SQL.

import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { produceOfficeTasksFromCommitments } from './produceTasks';

function fakeSupabase(opts: {
  openCommitmentIds: string[];
  rpcResults: Record<string, { data: unknown; error: { message: string } | null }>;
}) {
  const rpcCalls: { p_commitment_id: string }[] = [];
  const from = vi.fn((table: string) => {
    if (table === 'call_commitments') {
      return {
        select: () => ({
          eq: () => ({
            eq: async () => ({ data: opts.openCommitmentIds.map(id => ({ id })), error: null }),
          }),
        }),
      };
    }
    throw new Error(`unexpected table ${table}`);
  });
  const rpc = vi.fn(async (_fn: string, args: { p_commitment_id: string }) => {
    rpcCalls.push(args);
    return opts.rpcResults[args.p_commitment_id] ?? { data: null, error: null };
  });
  return { client: { from, rpc } as unknown as SupabaseClient, rpcCalls };
}

describe('produceOfficeTasksFromCommitments', () => {
  it('creates one task per open commitment and counts each success', async () => {
    const { client, rpcCalls } = fakeSupabase({
      openCommitmentIds: ['c-1', 'c-2'],
      rpcResults: {
        'c-1': { data: 'task-1', error: null },
        'c-2': { data: 'task-2', error: null },
      },
    });

    const result = await produceOfficeTasksFromCommitments(client, 't-1');

    expect(result).toEqual({ attempted: 2, created: 2 });
    expect(rpcCalls).toEqual([{ p_commitment_id: 'c-1' }, { p_commitment_id: 'c-2' }]);
  });

  it('does not count a commitment the RPC returned null for (already actioned, not open by the time it ran)', async () => {
    const { client } = fakeSupabase({
      openCommitmentIds: ['c-1'],
      rpcResults: { 'c-1': { data: null, error: null } },
    });

    const result = await produceOfficeTasksFromCommitments(client, 't-1');

    expect(result).toEqual({ attempted: 1, created: 0 });
  });

  it('a single commitment failing the RPC does not abort the batch -- best-effort, like the calls pipeline', async () => {
    const { client } = fakeSupabase({
      openCommitmentIds: ['c-1', 'c-2'],
      rpcResults: {
        'c-1': { data: null, error: { message: 'boom' } },
        'c-2': { data: 'task-2', error: null },
      },
    });

    const result = await produceOfficeTasksFromCommitments(client, 't-1');

    expect(result).toEqual({ attempted: 2, created: 1 });
  });

  it('returns zero attempted/created when the transcript has no open commitments', async () => {
    const { client } = fakeSupabase({ openCommitmentIds: [], rpcResults: {} });
    const result = await produceOfficeTasksFromCommitments(client, 't-1');
    expect(result).toEqual({ attempted: 0, created: 0 });
  });
});
