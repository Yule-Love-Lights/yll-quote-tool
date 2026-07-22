// Tests for the confirm-yes gate. Rather than asserting on mock call shapes,
// these run against a small behavioral fake of the bot_pending_actions table so
// the property that actually matters can be proven end-to-end: a pending write
// executes AT MOST ONCE, even when two confirmations race.

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Row = Record<string, unknown>;

const { dbRef } = vi.hoisted(() => ({ dbRef: { current: null as unknown } }));
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => dbRef.current }));

import {
  stagePendingAction,
  consumePendingAction,
  supersedeOpenActions,
  isAffirmative,
  isNegative,
} from './botConfirm';

// Minimal stand-in for the PostgREST builder covering only the operators this
// module uses. Filters compose; update/insert mutate the backing array, so the
// atomic `.is('consumed_at', null)` claim behaves like the real thing.
function makeDb(rows: Row[] = [], opts: { failInsert?: boolean } = {}) {
  let seq = 0;
  const api = {
    rows,
    from(_table: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let op: 'select' | 'insert' | 'update' = 'select';
      let payload: Row = {};
      let desc = false;

      const applyFilters = () => rows.filter((r) => filters.every((f) => f(r)));
      const targets = () => {
        const matched = applyFilters();
        return desc ? [...matched].reverse() : matched;
      };
      const run = (): { data: Row[]; error: null } => {
        if (op === 'insert') {
          if (opts.failInsert) return { data: [], error: null };
          const created = { id: `row-${++seq}`, consumed_at: null, created_at: new Date().toISOString(), ...payload };
          rows.push(created);
          return { data: [created], error: null };
        }
        if (op === 'update') {
          const matched = applyFilters();
          for (const r of matched) Object.assign(r, payload);
          return { data: matched, error: null };
        }
        return { data: targets(), error: null };
      };

      const builder = {
        select: () => builder,
        insert: (p: Row) => {
          op = 'insert';
          payload = p;
          return builder;
        },
        update: (p: Row) => {
          op = 'update';
          payload = p;
          return builder;
        },
        eq: (col: string, val: unknown) => {
          filters.push((r) => String(r[col]) === String(val));
          return builder;
        },
        is: (col: string, val: unknown) => {
          filters.push((r) => (val === null ? r[col] === null || r[col] === undefined : r[col] === val));
          return builder;
        },
        gt: (col: string, val: unknown) => {
          filters.push((r) => String(r[col]) > String(val));
          return builder;
        },
        order: () => {
          desc = true;
          return builder;
        },
        limit: () => builder,
        maybeSingle: async () => {
          const { data, error } = run();
          return { data: data[0] ?? null, error };
        },
        // supersedeOpenActions awaits the chain directly, with no maybeSingle().
        then: (resolve: (v: { data: Row[]; error: null }) => unknown) => Promise.resolve(run()).then(resolve),
      };
      return builder;
    },
  };
  return api;
}

const IDS = { chatId: '-100999', userId: '111' };

beforeEach(() => {
  dbRef.current = makeDb();
});

describe('isAffirmative / isNegative', () => {
  it('accepts the common yeses, case and punctuation insensitive', () => {
    for (const t of ['yes', 'Yes', 'YES!', 'y', 'yep', 'yup', 'confirm', 'ok', 'Okay.', 'do it', 'go']) {
      expect(isAffirmative(t)).toBe(true);
    }
  });

  it('accepts the common noes', () => {
    for (const t of ['no', 'N', 'nope', 'cancel', 'stop', 'never mind', 'abort']) {
      expect(isNegative(t)).toBe(true);
    }
  });

  it('treats anything ambiguous as NEITHER, so the gate re-asks instead of guessing', () => {
    for (const t of ['yes but change the qty', 'maybe', 'sure thing boss', 'ya', '']) {
      expect(isAffirmative(t)).toBe(false);
      expect(isNegative(t)).toBe(false);
    }
  });
});

describe('stagePendingAction', () => {
  it('returns null when Supabase is not configured', async () => {
    dbRef.current = null;
    expect(await stagePendingAction({ ...IDS, tool: 'completeInstall', args: {}, summary: 's' })).toBeNull();
  });

  it('returns null (not a false "pending") when the insert fails', async () => {
    dbRef.current = makeDb([], { failInsert: true });
    expect(await stagePendingAction({ ...IDS, tool: 'completeInstall', args: {}, summary: 's' })).toBeNull();
  });

  it('supersedes the sender\'s previous pending action so an old "yes" cannot fire it', async () => {
    const db = makeDb();
    dbRef.current = db;
    await stagePendingAction({ ...IDS, tool: 'completeInstall', args: { jobNumber: 1 }, summary: 'first' });
    await stagePendingAction({ ...IDS, tool: 'completeInstall', args: { jobNumber: 2 }, summary: 'second' });

    const open = db.rows.filter((r) => r.consumed_at === null);
    expect(open).toHaveLength(1);
    expect(open[0].summary).toBe('second');

    const claimed = await consumePendingAction(IDS.chatId, IDS.userId);
    expect(claimed?.summary).toBe('second');
  });

  it('leaves another sender in the same room untouched', async () => {
    const db = makeDb();
    dbRef.current = db;
    await stagePendingAction({ ...IDS, tool: 'completeInstall', args: {}, summary: 'naldo' });
    await stagePendingAction({ chatId: IDS.chatId, userId: '222', tool: 'completeInstall', args: {}, summary: 'jason' });

    expect(db.rows.filter((r) => r.consumed_at === null)).toHaveLength(2);
    expect((await consumePendingAction(IDS.chatId, '111'))?.summary).toBe('naldo');
    expect((await consumePendingAction(IDS.chatId, '222'))?.summary).toBe('jason');
  });
});

describe('consumePendingAction', () => {
  it('returns null when nothing is pending', async () => {
    expect(await consumePendingAction(IDS.chatId, IDS.userId)).toBeNull();
  });

  it('returns the staged tool and args', async () => {
    await stagePendingAction({
      ...IDS,
      tool: 'completeInstall',
      args: { jobNumber: 142, materials: [{ sku: 'C9', qty: 2 }] },
      summary: 'Close job #142?',
    });
    const claimed = await consumePendingAction(IDS.chatId, IDS.userId);
    expect(claimed).toMatchObject({
      tool: 'completeInstall',
      summary: 'Close job #142?',
      args: { jobNumber: 142, materials: [{ sku: 'C9', qty: 2 }] },
    });
  });

  it('executes AT MOST ONCE — a second "yes" finds nothing pending', async () => {
    await stagePendingAction({ ...IDS, tool: 'completeInstall', args: {}, summary: 'Close job #142?' });
    expect(await consumePendingAction(IDS.chatId, IDS.userId)).not.toBeNull();
    expect(await consumePendingAction(IDS.chatId, IDS.userId)).toBeNull();
  });

  it('ignores an expired action', async () => {
    const db = makeDb([
      {
        id: 'old',
        chat_id: IDS.chatId,
        user_id: IDS.userId,
        tool: 'completeInstall',
        args: {},
        summary: 'stale',
        consumed_at: null,
        created_at: '2020-01-01T00:00:00.000Z',
        expires_at: '2020-01-01T00:10:00.000Z',
      },
    ]);
    dbRef.current = db;
    expect(await consumePendingAction(IDS.chatId, IDS.userId)).toBeNull();
  });

  it('does not hand one sender another sender\'s pending action', async () => {
    await stagePendingAction({ ...IDS, tool: 'completeInstall', args: {}, summary: 'naldo only' });
    expect(await consumePendingAction(IDS.chatId, '222')).toBeNull();
  });

  it('returns null when Supabase is not configured', async () => {
    dbRef.current = null;
    expect(await consumePendingAction(IDS.chatId, IDS.userId)).toBeNull();
  });
});

describe('supersedeOpenActions', () => {
  it('closes open actions without running them', async () => {
    const db = makeDb();
    dbRef.current = db;
    await stagePendingAction({ ...IDS, tool: 'completeInstall', args: {}, summary: 'pending' });
    await supersedeOpenActions(IDS.chatId, IDS.userId);
    expect(db.rows.filter((r) => r.consumed_at === null)).toHaveLength(0);
    expect(await consumePendingAction(IDS.chatId, IDS.userId)).toBeNull();
  });

  it('no-ops safely when Supabase is not configured', async () => {
    dbRef.current = null;
    await expect(supersedeOpenActions(IDS.chatId, IDS.userId)).resolves.toBeUndefined();
  });
});
