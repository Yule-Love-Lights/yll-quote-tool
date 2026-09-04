// Tests for the free-spritzer notice record (Naldo, 2026-09-03: "let's create a
// record for it to log it correctly"). Supabase is mocked; what these pin is
// that a change is recorded with WHO, WHEN and WHAT THE CUSTOMER WAS BEING
// SHOWN, that a failed write is reported rather than swallowed, and that the
// history read is filtered in the database rather than in memory.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));

import {
  recordSpritzerNoticeChange,
  readSpritzerNoticeHistory,
  NOTICE_HIDDEN_ACTION,
  NOTICE_SHOWN_ACTION,
} from './spritzerNoticeAudit';

const QUOTE = '11111111-1111-1111-1111-111111111111';

type Row = Record<string, unknown>;

function makeSb(opts: { insertError?: string; insertThrows?: boolean; rows?: Row[]; readError?: string } = {}) {
  const inserted: Row[] = [];
  const filters: Array<[string, unknown]> = [];
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: () => b,
    insert: async (row: Row) => {
      if (opts.insertThrows) throw new Error('socket hang up');
      inserted.push(row);
      return opts.insertError ? { error: { message: opts.insertError } } : { error: null };
    },
    select: () => b,
    in: (col: string, vals: unknown) => {
      filters.push([col, vals]);
      return b;
    },
    eq: (col: string, val: unknown) => {
      filters.push([col, val]);
      return b;
    },
    order: () => b,
    limit: async () =>
      opts.readError ? { data: null, error: { message: opts.readError } } : { data: opts.rows ?? [], error: null },
  });
  return { client: b, inserted, filters };
}

beforeEach(() => {
  sbRef.current = null;
});

describe('recordSpritzerNoticeChange', () => {
  it('records who hid it, on which quote, and the promise that was showing', async () => {
    const { client, inserted } = makeSb();
    sbRef.current = client;

    const ok = await recordSpritzerNoticeChange({
      quoteId: QUOTE,
      quoteNumber: 1255,
      hidden: true,
      count: 6,
      actor: 'jason@yulelovelights.com',
    });

    expect(ok).toBe(true);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual({
      actor: 'jason@yulelovelights.com',
      action: NOTICE_HIDDEN_ACTION,
      detail: { quoteId: QUOTE, quoteNumber: 1255, count: 6 },
    });
  });

  it('uses a different action when the notice is put back', async () => {
    const { client, inserted } = makeSb();
    sbRef.current = client;
    await recordSpritzerNoticeChange({
      quoteId: QUOTE,
      quoteNumber: 1255,
      hidden: false,
      count: null,
      actor: 'jason@yulelovelights.com',
    });
    expect(inserted[0].action).toBe(NOTICE_SHOWN_ACTION);
  });

  it('falls back to the system actor when no operator resolved', async () => {
    const { client, inserted } = makeSb();
    sbRef.current = client;
    await recordSpritzerNoticeChange({ quoteId: QUOTE, quoteNumber: null, hidden: true, count: 2, actor: null });
    expect(inserted[0].actor).toBe('system');
  });

  it('reports a failed write instead of claiming a record exists', async () => {
    const { client } = makeSb({ insertError: 'permission denied' });
    sbRef.current = client;
    const ok = await recordSpritzerNoticeChange({
      quoteId: QUOTE,
      quoteNumber: 1,
      hidden: true,
      count: 2,
      actor: 'a@b.c',
    });
    expect(ok).toBe(false);
  });

  it('never throws when the client rejects, because the toggle already succeeded', async () => {
    // supabase-js reports a failed insert as { error }, but a network-level
    // failure REJECTS. A throw here would 500 a request whose change had
    // already landed.
    const { client } = makeSb({ insertThrows: true });
    sbRef.current = client;
    await expect(
      recordSpritzerNoticeChange({ quoteId: QUOTE, quoteNumber: 1, hidden: true, count: 2, actor: 'a@b.c' }),
    ).resolves.toBe(false);
  });

  it('reports false rather than throwing when Supabase is not configured', async () => {
    sbRef.current = null;
    await expect(
      recordSpritzerNoticeChange({ quoteId: QUOTE, quoteNumber: 1, hidden: true, count: 2, actor: 'a@b.c' }),
    ).resolves.toBe(false);
  });
});

describe('readSpritzerNoticeHistory', () => {
  it('filters by quote IN THE DATABASE, not in memory', async () => {
    // dashboard_activity carries well over a thousand rows; reading them all
    // back to filter here would get slower every week.
    const { client, filters } = makeSb({ rows: [] });
    sbRef.current = client;
    await readSpritzerNoticeHistory(QUOTE);
    expect(filters).toContainEqual(['detail->>quoteId', QUOTE]);
    expect(filters).toContainEqual(['action', [NOTICE_HIDDEN_ACTION, NOTICE_SHOWN_ACTION]]);
  });

  it('maps rows into the shape the panel renders', async () => {
    const { client } = makeSb({
      rows: [
        {
          actor: 'jason@yulelovelights.com',
          action: NOTICE_HIDDEN_ACTION,
          detail: { quoteId: QUOTE, count: 6 },
          created_at: '2026-09-03T12:00:00Z',
        },
        {
          actor: null,
          action: NOTICE_SHOWN_ACTION,
          detail: { quoteId: QUOTE },
          created_at: '2026-09-02T12:00:00Z',
        },
      ],
    });
    sbRef.current = client;
    const history = await readSpritzerNoticeHistory(QUOTE);
    expect(history).toEqual([
      { hidden: true, actor: 'jason@yulelovelights.com', at: '2026-09-03T12:00:00Z', count: 6 },
      { hidden: false, actor: 'system', at: '2026-09-02T12:00:00Z', count: null },
    ]);
  });

  it('returns an empty history rather than throwing when the read fails', async () => {
    const { client } = makeSb({ readError: 'boom' });
    sbRef.current = client;
    await expect(readSpritzerNoticeHistory(QUOTE)).resolves.toEqual([]);
  });
});
