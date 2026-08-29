// Tests for the Office Tasks data layer (calls merge plan S1). The Supabase
// client is mocked (a fake chainable query builder for the list read, a
// plain rpc() mock for the two mutations) — this module's own row mapping,
// view dispatch, and Postgres-error-to-outcome mapping run for real. The
// RPCs' own logic (advisory lock, idempotency replay, immutability triggers)
// is NOT retested here — see the migration's own porting-note comments —
// this only proves the wrapper calls the right RPC with the right args and
// interprets every documented error code correctly.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));

import {
  createManualOfficeTask,
  databaseErrorCode,
  isOfficeTasksSchemaUnavailable,
  listOfficeTasks,
  updateOfficeTaskStatus,
} from './officeTasks';

type Row = Record<string, unknown>;

/** A chainable fake query builder — every filter/order method returns
 * itself, and it resolves like a real Supabase PostgrestFilterBuilder
 * (thenable) to the configured { data, error } once awaited. */
function makeListClient(result: { data: Row[] | null; error: { code?: string } | null }) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {};
  const record = (method: string) => (...args: unknown[]) => {
    calls.push({ method, args });
    return builder;
  };
  Object.assign(builder, {
    from: record('from'),
    select: record('select'),
    or: record('or'),
    in: record('in'),
    order: record('order'),
    then: (resolve: (v: typeof result) => void) => resolve(result),
  });
  return { client: builder, calls };
}

function makeRpcClient(result: { data: unknown; error: { code?: string } | null }) {
  const rpc = vi.fn(async () => result);
  return { client: { rpc }, rpc };
}

const ROW: Row = {
  id: 't-1',
  source_system: 'manual',
  title: 'Call the vendor',
  detail: null,
  status: 'open',
  due_at: '2026-08-29T12:00:00.000Z',
  created_at: '2026-08-28T12:00:00.000Z',
  updated_at: '2026-08-28T12:00:00.000Z',
  blocked_reason: null,
  dismissal_reason: null,
  completed_at: null,
  dismissed_at: null,
};

beforeEach(() => {
  sbRef.current = null;
});

describe('databaseErrorCode / isOfficeTasksSchemaUnavailable', () => {
  it('reads the code off a Postgres/PostgREST error object', () => {
    expect(databaseErrorCode({ code: '23505' })).toBe('23505');
    expect(databaseErrorCode({})).toBeNull();
    expect(databaseErrorCode(null)).toBeNull();
    expect(databaseErrorCode('boom')).toBeNull();
  });

  it('flags missing-table/missing-function codes as schema-unavailable', () => {
    for (const code of ['42P01', 'PGRST205', '42883', 'PGRST202']) {
      expect(isOfficeTasksSchemaUnavailable({ code })).toBe(true);
    }
  });

  it('does not flag an unrelated error code', () => {
    expect(isOfficeTasksSchemaUnavailable({ code: '23505' })).toBe(false);
    expect(isOfficeTasksSchemaUnavailable(null)).toBe(false);
  });
});

describe('listOfficeTasks', () => {
  it('returns unavailable when Supabase is not configured', async () => {
    sbRef.current = null;
    const result = await listOfficeTasks('op-1', 'active');
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('active view filters to open+blocked, scoped to creator-or-assignee OR any non-manual row, ordered by due date', async () => {
    const { client, calls } = makeListClient({ data: [ROW], error: null });
    sbRef.current = client;
    const result = await listOfficeTasks('op-1', 'active');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ id: 't-1', sourceSystem: 'manual', status: 'open' });

    const orCall = calls.find((c) => c.method === 'or');
    expect(orCall?.args[0]).toBe('created_by.eq.op-1,assigned_to.eq.op-1,source_system.neq.manual');
    const inCall = calls.find((c) => c.method === 'in');
    expect(inCall?.args).toEqual(['status', ['open', 'blocked']]);
    const orderCalls = calls.filter((c) => c.method === 'order');
    expect(orderCalls[0].args).toEqual(['due_at', { ascending: true }]);
  });

  it('visibility widening (S6): the same filter string is sent for EVERY actor -- a call_commitment/quote_tool row (source_system.neq.manual) is visible to any operator regardless of created_by/assigned_to, while a manual row still requires the actor be creator or assignee', async () => {
    const { client: clientA, calls: callsA } = makeListClient({ data: [], error: null });
    sbRef.current = clientA;
    await listOfficeTasks('operator-a', 'active');
    const orCallA = callsA.find((c) => c.method === 'or');
    expect(orCallA?.args[0]).toBe('created_by.eq.operator-a,assigned_to.eq.operator-a,source_system.neq.manual');

    const { client: clientB, calls: callsB } = makeListClient({ data: [], error: null });
    sbRef.current = clientB;
    await listOfficeTasks('operator-b', 'active');
    const orCallB = callsB.find((c) => c.method === 'or');
    // Different actor, same filter SHAPE -- source_system.neq.manual is
    // actor-independent, so a call_commitment task created by nobody
    // (created_by/assigned_to both null) matches this OR clause for BOTH
    // operator-a and operator-b, while a manual task created by operator-a
    // matches only operator-a's created_by.eq/assigned_to.eq legs.
    expect(orCallB?.args[0]).toBe('created_by.eq.operator-b,assigned_to.eq.operator-b,source_system.neq.manual');
    expect(orCallA?.args[0]).not.toBe(orCallB?.args[0]);
  });

  it('history view filters to completed+dismissed, ordered by most-recently-touched first', async () => {
    const { client, calls } = makeListClient({ data: [], error: null });
    sbRef.current = client;
    await listOfficeTasks('op-1', 'history');
    const inCall = calls.find((c) => c.method === 'in');
    expect(inCall?.args).toEqual(['status', ['completed', 'dismissed']]);
    const orderCalls = calls.filter((c) => c.method === 'order');
    expect(orderCalls[0].args).toEqual(['updated_at', { ascending: false }]);
  });

  it('maps a missing-table error to not_ready (the migration is not applied yet)', async () => {
    const { client } = makeListClient({ data: null, error: { code: '42P01' } });
    sbRef.current = client;
    const result = await listOfficeTasks('op-1', 'active');
    expect(result).toEqual({ ok: false, reason: 'not_ready' });
  });

  it('maps any other read error to unavailable', async () => {
    const { client } = makeListClient({ data: null, error: { code: '08006' } });
    sbRef.current = client;
    const result = await listOfficeTasks('op-1', 'active');
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('treats a null data payload as an empty list, not a crash', async () => {
    const { client } = makeListClient({ data: null, error: null });
    sbRef.current = client;
    const result = await listOfficeTasks('op-1', 'active');
    expect(result).toEqual({ ok: true, tasks: [] });
  });
});

describe('createManualOfficeTask', () => {
  const input = { title: 'Call the vendor', detail: null, dueAt: null, actorId: 'op-1', idempotencyKey: 'key-1' };

  it('returns unavailable when Supabase is not configured', async () => {
    sbRef.current = null;
    const result = await createManualOfficeTask(input);
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('calls office_tasks_create_manual with the RPC-shaped params and returns the taskId', async () => {
    const { client, rpc } = makeRpcClient({ data: 'new-task-id', error: null });
    sbRef.current = client;
    const result = await createManualOfficeTask(input);
    expect(result).toEqual({ ok: true, taskId: 'new-task-id' });
    expect(rpc).toHaveBeenCalledWith('office_tasks_create_manual', {
      p_title: 'Call the vendor',
      p_detail: null,
      p_due_at: null,
      p_actor: 'op-1',
      p_idempotency_key: 'key-1',
    });
  });

  it.each([
    ['42P01', 'not_ready'],
    ['PGRST205', 'not_ready'],
    ['42883', 'not_ready'],
    ['PGRST202', 'not_ready'],
    ['23505', 'idempotency_conflict'],
    ['42501', 'access_denied'],
    ['22023', 'invalid'],
    ['23502', 'invalid'],
    ['23514', 'invalid'],
    ['99999', 'failed'],
  ] as const)('maps Postgres code %s to reason %s', async (code, reason) => {
    const { client } = makeRpcClient({ data: null, error: { code } });
    sbRef.current = client;
    const result = await createManualOfficeTask(input);
    expect(result).toEqual({ ok: false, reason });
  });
});

describe('updateOfficeTaskStatus', () => {
  const input = { taskId: 't-1', status: 'completed' as const, reason: null, actorId: 'op-1', idempotencyKey: 'key-1' };

  it('returns unavailable when Supabase is not configured', async () => {
    sbRef.current = null;
    const result = await updateOfficeTaskStatus(input);
    expect(result).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('calls office_tasks_update_status with the RPC-shaped params and returns the taskId', async () => {
    const { client, rpc } = makeRpcClient({ data: 't-1', error: null });
    sbRef.current = client;
    const result = await updateOfficeTaskStatus(input);
    expect(result).toEqual({ ok: true, taskId: 't-1' });
    expect(rpc).toHaveBeenCalledWith('office_tasks_update_status', {
      p_task_id: 't-1',
      p_status: 'completed',
      p_reason: null,
      p_actor: 'op-1',
      p_idempotency_key: 'key-1',
    });
  });

  it.each([
    ['42P01', 'not_ready'],
    ['PGRST202', 'not_ready'],
    ['23505', 'idempotency_conflict'],
    // Ownership violation and "doesn't exist" BOTH collapse to not_found —
    // a non-owner can't probe existence via a different code/status.
    ['42501', 'not_found'],
    ['23503', 'not_found'],
    ['22023', 'state_conflict'],
    ['23514', 'state_conflict'],
    ['99999', 'failed'],
  ] as const)('maps Postgres code %s to reason %s', async (code, reason) => {
    const { client } = makeRpcClient({ data: null, error: { code } });
    sbRef.current = client;
    const result = await updateOfficeTaskStatus(input);
    expect(result).toEqual({ ok: false, reason });
  });
});
