// Tests for the customer behind an Office Task: the pure detail-trimming
// rule, and the two-hop resolution that turns a task into a linkable
// HighLevel contact id.
//
// The Supabase client is mocked with a TABLE-AWARE fake, unlike the single
// result builder in officeTasks.test.ts, because this path reads three
// different tables in one list call (office_tasks, call_commitments,
// dashboard_contacts) and the whole point is what happens when one of them
// answers differently from the others.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));

import { listOfficeTasks, stripCustomerLine } from './officeTasks';

type Row = Record<string, unknown>;
type TableResult = { data: Row[] | null; error: { code?: string } | null };

/**
 * A fake Supabase client that answers per TABLE. Every builder method
 * returns the builder, and awaiting it resolves to whatever `results` holds
 * for the table named in the most recent from() call. A table with no entry
 * resolves to an empty list, which is the honest default: it is what a real
 * query returns when nothing matches.
 */
function makeClient(results: Record<string, TableResult>) {
  let table = '';
  const builder: Record<string, unknown> = {};
  const passthrough = () => builder;
  Object.assign(builder, {
    from: (name: string) => {
      table = name;
      return builder;
    },
    select: passthrough,
    in: passthrough,
    or: passthrough,
    order: passthrough,
    then: (resolve: (v: TableResult) => void) =>
      resolve(results[table] ?? { data: [], error: null }),
    auth: { admin: { getUserById: async () => ({ data: null, error: { message: 'not found' } }) } },
  });
  return builder;
}

const TASK: Row = {
  id: 'task-1',
  source_system: 'call_commitment',
  source_event_id: 'commit-1',
  title: 'Send quote: send the roofline quote',
  detail: 'send the roofline quote\n\nSharon McDonough - +16313120936\n\nCall taken by Rep One',
  status: 'open',
  due_at: '2026-09-02T12:00:00.000Z',
  created_at: '2026-09-01T12:00:00.000Z',
  updated_at: '2026-09-01T12:00:00.000Z',
  blocked_reason: null,
  dismissal_reason: null,
  completed_at: null,
  dismissed_at: null,
  created_by: null,
  assigned_to: null,
};

beforeEach(() => {
  sbRef.current = null;
});

describe('stripCustomerLine', () => {
  it('removes the producer\'s "Name - phone" block and keeps everything else', () => {
    const detail = 'send the roofline quote\n\nSharon McDonough - +16313120936\n\nCall taken by Rep One';
    expect(stripCustomerLine(detail)).toBe('send the roofline quote\n\nCall taken by Rep One');
  });

  it('never removes the first block, even when it happens to look like a customer line', () => {
    const detail = 'Sharon McDonough - +16313120936\n\nCall taken by Rep One';
    expect(stripCustomerLine(detail)).toBe(detail);
  });

  it('leaves a name-only line alone rather than guessing it is the customer', () => {
    const detail = 'send the quote\n\nSharon McDonough\n\nCall taken by Rep One';
    expect(stripCustomerLine(detail)).toBe(detail);
  });

  it('leaves a detail that legitimately ends in a hyphenated clause alone', () => {
    const detail = 'send the quote\n\nprice the gutter line - the one over the garage';
    expect(stripCustomerLine(detail)).toBe(detail);
  });

  it('passes null and a single-block detail straight through', () => {
    expect(stripCustomerLine(null)).toBeNull();
    expect(stripCustomerLine('just the one line')).toBe('just the one line');
  });
});

describe('listOfficeTasks customer resolution', () => {
  it('resolves a task to its HighLevel contact id and display name', async () => {
    sbRef.current = makeClient({
      office_tasks: { data: [TASK], error: null },
      call_commitments: { data: [{ id: 'commit-1', ghl_contact_id: 'hl-99' }], error: null },
      dashboard_contacts: {
        data: [{ ghl_contact_id: 'hl-99', display_name: 'Sharon McDonough', primary_phone: '+16313120936' }],
        error: null,
      },
    });
    const result = await listOfficeTasks('op-1', 'active');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tasks[0].customerContactId).toBe('hl-99');
    expect(result.tasks[0].customerName).toBe('Sharon McDonough');
    // The link now carries the name, so the duplicated block is gone.
    expect(result.tasks[0].detail).toBe('send the roofline quote\n\nCall taken by Rep One');
  });

  it('still links a contact whose dashboard_contacts row has no display name', async () => {
    sbRef.current = makeClient({
      office_tasks: { data: [TASK], error: null },
      call_commitments: { data: [{ id: 'commit-1', ghl_contact_id: 'hl-99' }], error: null },
      dashboard_contacts: {
        data: [{ ghl_contact_id: 'hl-99', display_name: '   ', primary_phone: null }],
        error: null,
      },
    });
    const result = await listOfficeTasks('op-1', 'active');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tasks[0].customerContactId).toBe('hl-99');
    expect(result.tasks[0].customerName).toBeNull();
  });

  it('leaves a task with no matching commitment unlinked, and keeps its detail intact', async () => {
    sbRef.current = makeClient({
      office_tasks: { data: [TASK], error: null },
      call_commitments: { data: [], error: null },
    });
    const result = await listOfficeTasks('op-1', 'active');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tasks[0].customerContactId).toBeNull();
    expect(result.tasks[0].customerName).toBeNull();
    // Nothing on screen carries the name, so the detail must keep it.
    expect(result.tasks[0].detail).toBe(TASK.detail);
  });

  it('returns the list anyway when the commitment read fails, rather than failing the whole page', async () => {
    sbRef.current = makeClient({
      office_tasks: { data: [TASK], error: null },
      call_commitments: { data: null, error: { code: '42P01' } },
    });
    const result = await listOfficeTasks('op-1', 'active');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].customerContactId).toBeNull();
    expect(result.tasks[0].detail).toBe(TASK.detail);
  });

  // Named for what it actually proves. A mutation probe showed that removing
  // the source_system === 'call_commitment' filter does NOT fail this test,
  // because the null source_event_id is what keeps the task unlinked. That
  // filter is belt and braces: the database's own
  // office_tasks_source_event_presence constraint already makes a manual row
  // with a source_event_id impossible, so there is no honest fixture that
  // would isolate it.
  it('leaves a task with no source_event_id unlinked, which is every manual task', async () => {
    const manual: Row = { ...TASK, id: 'task-2', source_system: 'manual', source_event_id: null, created_by: 'op-1' };
    sbRef.current = makeClient({
      office_tasks: { data: [manual], error: null },
      call_commitments: { data: [{ id: 'commit-1', ghl_contact_id: 'hl-99' }], error: null },
    });
    const result = await listOfficeTasks('op-1', 'active');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tasks[0].customerContactId).toBeNull();
  });
});
