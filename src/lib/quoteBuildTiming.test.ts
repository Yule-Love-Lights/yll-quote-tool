import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sbRef, afterCallbacks, getOperatorMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  afterCallbacks: [] as Array<() => Promise<void>>,
  getOperatorMock: vi.fn(),
}));

vi.mock('next/server', () => ({
  after: (callback: () => Promise<void>) => afterCallbacks.push(callback),
}));

vi.mock('./auth/supabaseServer', () => ({
  getOperator: getOperatorMock,
}));

vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
}));

import {
  completeQuoteBuildSession,
  computeQuoteBuildTimingStats,
  QUOTE_BUILD_IDLE_CAP_SECONDS,
  getOwnedQuoteBuildSession,
  linkQuoteBuildSession,
  listQuoteBuildTimingStats,
  queueQuoteBuildSessionCompletion,
  quoteBuildSessionTargetState,
  startQuoteBuildSession,
  type QuoteBuildSessionRow,
} from './quoteBuildTiming';

const TIMER_ID = '11111111-2222-4333-8444-555555555555';
const QUOTE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OPERATOR_ID = '99999999-8888-4777-8666-555555555555';

beforeEach(() => {
  afterCallbacks.length = 0;
  getOperatorMock.mockReset();
  getOperatorMock.mockResolvedValue({ id: OPERATOR_ID });
});

function row(overrides: Partial<QuoteBuildSessionRow> = {}): QuoteBuildSessionRow {
  return {
    id: TIMER_ID,
    started_at: '2026-08-21T12:00:00.000Z',
    start_reason: 'contact_selected',
    started_by: OPERATOR_ID,
    started_by_label: 'Alex',
    quote_id: QUOTE_ID,
    sent_at: '2026-08-21T12:10:00.000Z',
    ...overrides,
  };
}

describe('computeQuoteBuildTimingStats', () => {
  it('groups by staff and computes count, average, median, and nearest-rank p90', () => {
    const rows = [1, 2, 3, 4, 20].map((minutes, index) =>
      row({
        id: `00000000-0000-4000-8000-00000000000${index}`,
        sent_at: new Date(Date.parse('2026-08-21T12:00:00.000Z') + minutes * 60_000).toISOString(),
      }),
    );
    rows.push(
      row({
        id: '22222222-2222-4222-8222-222222222222',
        started_by: '33333333-3333-4333-8333-333333333333',
        started_by_label: 'Blair',
        sent_at: '2026-08-21T12:30:00.000Z',
      }),
    );

    expect(computeQuoteBuildTimingStats(rows)).toEqual([
      {
        operatorId: OPERATOR_ID,
        operatorLabel: 'Alex',
        count: 5,
        averageSeconds: 360,
        medianSeconds: 180,
        p90Seconds: 1200,
        excludedCount: 0,
      },
      {
        operatorId: '33333333-3333-4333-8333-333333333333',
        operatorLabel: 'Blair',
        count: 1,
        averageSeconds: 1800,
        medianSeconds: 1800,
        p90Seconds: 1800,
        excludedCount: 0,
      },
    ]);
  });

  it('ignores incomplete, invalid, and negative sessions without inventing zeros', () => {
    expect(
      computeQuoteBuildTimingStats([
        row({ sent_at: null }),
        row({ id: '22222222-2222-4222-8222-222222222222', sent_at: 'not-a-date' }),
        row({
          id: '33333333-3333-4333-8333-333333333333',
          started_at: '2026-08-21T13:00:00.000Z',
          sent_at: '2026-08-21T12:00:00.000Z',
        }),
      ]),
    ).toEqual([]);
  });

  // Ledger row 374: the session is wall-clock and nothing pauses it, so a draft
  // opened before lunch and sent after would otherwise dominate the average.
  it('excludes a session past the idle cap from the figures and counts it separately', () => {
    const stats = computeQuoteBuildTimingStats([
      row({ started_at: '2026-08-21T12:00:00.000Z', sent_at: '2026-08-21T12:10:00.000Z' }),
      row({
        id: '44444444-4444-4444-8444-444444444444',
        started_at: '2026-08-21T09:00:00.000Z',
        sent_at: '2026-08-21T17:00:00.000Z', // eight hours, a resumed draft
      }),
    ]);

    expect(stats).toEqual([
      expect.objectContaining({
        count: 1,
        averageSeconds: 600, // the ten-minute build only, not the eight-hour one
        excludedCount: 1,
      }),
    ]);
  });

  it('keeps a staffer visible with no usable sessions rather than dropping them', () => {
    expect(
      computeQuoteBuildTimingStats([
        row({ started_at: '2026-08-21T00:00:00.000Z', sent_at: '2026-08-21T09:00:00.000Z' }),
      ]),
    ).toEqual([
      expect.objectContaining({ operatorLabel: 'Alex', count: 0, excludedCount: 1 }),
    ]);
  });

  it('keeps a session exactly at the cap, excluding only what runs past it', () => {
    const atCap = computeQuoteBuildTimingStats([
      row({ started_at: '2026-08-21T12:00:00.000Z', sent_at: '2026-08-21T14:00:00.000Z' }),
    ]);
    expect(atCap).toEqual([
      expect.objectContaining({ count: 1, averageSeconds: QUOTE_BUILD_IDLE_CAP_SECONDS, excludedCount: 0 }),
    ]);
  });

  it('keeps former staff visible through the stored label', () => {
    expect(computeQuoteBuildTimingStats([row({ started_by: null, started_by_label: 'Former staff' })])).toEqual([
      expect.objectContaining({ operatorId: null, operatorLabel: 'Former staff', count: 1 }),
    ]);
  });

  it('uses the newest stored label when a staff member has been renamed', () => {
    expect(
      computeQuoteBuildTimingStats([
        row({
          started_by_label: 'Current name',
          started_at: '2026-08-21T12:00:00.000Z',
          sent_at: '2026-08-21T12:10:00.000Z',
        }),
        row({
          id: '22222222-2222-4222-8222-222222222222',
          started_by_label: 'Old name',
          started_at: '2026-08-20T12:00:00.000Z',
          sent_at: '2026-08-20T12:10:00.000Z',
        }),
      ])[0],
    ).toEqual(expect.objectContaining({ operatorLabel: 'Current name', count: 2 }));
  });
});

describe('quote build session persistence', () => {
  it('positive-gates saved targets to real, editable drafts', async () => {
    const maybeSingle = vi.fn(async () => ({
      data: {
        status: 'draft',
        quote_sent_at: null,
        customer_approved_at: null,
        deposit_paid_at: null,
        viewed_at: null,
        is_test: false,
        view_only: false,
      },
      error: null,
    }));
    const abortSignal = vi.fn(() => ({ maybeSingle }));
    const eq = vi.fn(() => ({ abortSignal }));
    const select = vi.fn(() => ({ eq }));
    sbRef.current = { from: vi.fn(() => ({ select })) };

    await expect(quoteBuildSessionTargetState(QUOTE_ID)).resolves.toEqual({ kind: 'draft' });
    maybeSingle.mockResolvedValueOnce({
      data: {
        status: 'draft',
        quote_sent_at: null,
        customer_approved_at: null,
        deposit_paid_at: null,
        viewed_at: null,
        is_test: true,
        view_only: false,
      },
      error: null,
    });
    await expect(quoteBuildSessionTargetState(QUOTE_ID)).resolves.toEqual({ kind: 'ineligible' });
  });

  it.each([
    ['view-only', { view_only: true }],
    ['already viewed', { viewed_at: '2026-08-21T12:00:00.000Z' }],
    ['already approved', { customer_approved_at: '2026-08-21T12:00:00.000Z' }],
  ])('rejects a %s quote target', async (_label, overrides) => {
    const maybeSingle = vi.fn(async () => ({
      data: {
        status: 'draft',
        quote_sent_at: null,
        customer_approved_at: null,
        deposit_paid_at: null,
        viewed_at: null,
        is_test: false,
        view_only: false,
        ...overrides,
      },
      error: null,
    }));
    sbRef.current = {
      from: () => ({
        select: () => ({
          eq: () => ({ abortSignal: () => ({ maybeSingle }) }),
        }),
      }),
    };

    await expect(quoteBuildSessionTargetState(QUOTE_ID)).resolves.toEqual({ kind: 'ineligible' });
  });

  it('returns the authoritative first-send time for a late link', async () => {
    const sentAt = '2026-08-21T12:10:00.000Z';
    const maybeSingle = vi.fn(async () => ({
      data: {
        status: 'sent',
        quote_sent_at: sentAt,
        customer_approved_at: null,
        deposit_paid_at: null,
        viewed_at: null,
        is_test: false,
        view_only: false,
      },
      error: null,
    }));
    sbRef.current = {
      from: () => ({
        select: () => ({
          eq: () => ({ abortSignal: () => ({ maybeSingle }) }),
        }),
      }),
    };

    await expect(quoteBuildSessionTargetState(QUOTE_ID)).resolves.toEqual({ kind: 'sent', sentAt });
  });

  it('aborts a stalled database lookup after the telemetry budget', async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | null = null;
      const maybeSingle = vi.fn(
        () => new Promise<{ data: null; error: { message: string } }>((resolve) => {
          capturedSignal?.addEventListener('abort', () => {
            resolve({ data: null, error: { message: 'aborted' } });
          });
        }),
      );
      sbRef.current = {
        from: () => ({
          select: () => ({
            eq: () => ({
              abortSignal: (signal: AbortSignal) => {
                capturedSignal = signal;
                return { maybeSingle };
              },
            }),
          }),
        }),
      };

      const pending = quoteBuildSessionTargetState(QUOTE_ID);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(pending).resolves.toBeNull();
      expect((capturedSignal as unknown as AbortSignal).aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts with server-verified staff identity and returns the inserted row', async () => {
    const inserted = row({ quote_id: null, sent_at: null });
    const single = vi.fn(async () => ({ data: inserted, error: null }));
    const abortSignal = vi.fn(() => ({ single }));
    const select = vi.fn(() => ({ abortSignal }));
    const insert = vi.fn(() => ({ select }));
    sbRef.current = { from: vi.fn(() => ({ insert })) };

    await expect(
      startQuoteBuildSession({
        timerId: TIMER_ID,
        startReason: 'contact_selected',
        operator: { id: OPERATOR_ID, name: ' Alex ', email: 'alex@example.com' },
      }),
    ).resolves.toEqual({ ok: true, kind: 'started', row: inserted });
    expect(insert).toHaveBeenCalledWith({
      id: TIMER_ID,
      start_reason: 'contact_selected',
      started_by: OPERATOR_ID,
      started_by_label: 'Alex',
      quote_id: null,
    });
  });

  it('starts an existing draft timer already linked to that quote', async () => {
    const startedAt = '2026-08-21T11:59:59.000Z';
    const inserted = row({ quote_id: QUOTE_ID, sent_at: null });
    const single = vi.fn(async () => ({ data: inserted, error: null }));
    const abortSignal = vi.fn(() => ({ single }));
    const select = vi.fn(() => ({ abortSignal }));
    const insert = vi.fn(() => ({ select }));
    sbRef.current = { from: vi.fn(() => ({ insert })) };

    await expect(
      startQuoteBuildSession({
        timerId: TIMER_ID,
        startReason: 'prefilled_open',
        operator: { id: OPERATOR_ID, name: 'Alex', email: 'alex@example.com' },
        quoteId: QUOTE_ID,
        startedAt,
      }),
    ).resolves.toEqual({ ok: true, kind: 'started', row: inserted });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({ quote_id: QUOTE_ID, started_at: startedAt }),
    );
  });

  it('returns the original same-staff timer on a retry without resetting its start', async () => {
    const existing = row({ quote_id: null, sent_at: null });
    const insert = vi.fn(() => ({
      select: () => ({
        abortSignal: () => ({
          single: async () => ({ data: null, error: { code: '23505', message: 'duplicate' } }),
        }),
      }),
    }));
    const select = vi.fn(() => ({
      eq: () => ({
        abortSignal: () => ({
          maybeSingle: async () => ({ data: existing, error: null }),
        }),
      }),
    }));
    sbRef.current = { from: vi.fn(() => ({ insert, select })) };

    await expect(
      startQuoteBuildSession({
        timerId: TIMER_ID,
        startReason: 'prefilled_open',
        operator: { id: OPERATOR_ID, name: 'Renamed staff', email: 'new@example.com' },
      }),
    ).resolves.toEqual({ ok: true, kind: 'existing', row: existing });
    expect(insert).toHaveBeenCalledOnce();
  });

  it('restores the earlier server start when Calculate inserted the timer first', async () => {
    const delayedStartedAt = '2026-08-21T12:00:00.000Z';
    const saveInserted = row({
      started_at: '2026-08-21T12:05:00.000Z',
      quote_id: QUOTE_ID,
      sent_at: '2026-08-21T12:06:00.000Z',
    });
    const corrected = row({
      started_at: delayedStartedAt,
      quote_id: QUOTE_ID,
      sent_at: '2026-08-21T12:06:00.000Z',
    });
    const insert = vi.fn(() => ({
      select: () => ({
        abortSignal: () => ({
          single: async () => ({ data: null, error: { code: '23505', message: 'duplicate' } }),
        }),
      }),
    }));
    const readMaybeSingle = vi.fn(async () => ({ data: saveInserted, error: null }));
    const readAbortSignal = vi.fn(() => ({ maybeSingle: readMaybeSingle }));
    const readEq = vi.fn(() => ({ abortSignal: readAbortSignal }));
    const select = vi.fn(() => ({ eq: readEq }));
    const updateMaybeSingle = vi.fn(async () => ({ data: corrected, error: null }));
    const updateAbortSignal = vi.fn(() => ({ maybeSingle: updateMaybeSingle }));
    const updateSelect = vi.fn(() => ({ abortSignal: updateAbortSignal }));
    const gt = vi.fn(() => ({ select: updateSelect }));
    const eqOperator = vi.fn(() => ({ gt }));
    const eqId = vi.fn(() => ({ eq: eqOperator }));
    const update = vi.fn(() => ({ eq: eqId }));
    sbRef.current = { from: vi.fn(() => ({ insert, select, update })) };

    await expect(
      startQuoteBuildSession({
        timerId: TIMER_ID,
        startReason: 'contact_selected',
        operator: { id: OPERATOR_ID, name: 'Alex', email: 'alex@example.com' },
        quoteId: QUOTE_ID,
        startedAt: delayedStartedAt,
      }),
    ).resolves.toEqual({ ok: true, kind: 'existing', row: corrected });
    expect(update).toHaveBeenCalledWith({ started_at: delayedStartedAt });
    expect(eqId).toHaveBeenCalledWith('id', TIMER_ID);
    expect(eqOperator).toHaveBeenCalledWith('started_by', OPERATOR_ID);
    expect(gt).toHaveBeenCalledWith('started_at', delayedStartedAt);
  });

  it('reads an existing timer only for its server-verified starting staff member', async () => {
    const existing = row({ quote_id: null, sent_at: null });
    const maybeSingle = vi.fn(async () => ({ data: existing, error: null }));
    const abortSignal = vi.fn(() => ({ maybeSingle }));
    const eqOperator = vi.fn(() => ({ abortSignal }));
    const eqId = vi.fn(() => ({ eq: eqOperator }));
    const select = vi.fn(() => ({ eq: eqId }));
    sbRef.current = { from: vi.fn(() => ({ select })) };

    await expect(
      getOwnedQuoteBuildSession({ timerId: TIMER_ID, operatorId: OPERATOR_ID }),
    ).resolves.toEqual(existing);
    expect(eqId).toHaveBeenCalledWith('id', TIMER_ID);
    expect(eqOperator).toHaveBeenCalledWith('started_by', OPERATOR_ID);
  });

  it('links only the starting staff member\'s unfinished timer', async () => {
    const maybeSingle = vi.fn(async () => ({ data: row({ sent_at: null }), error: null }));
    const abortSignal = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ abortSignal }));
    const quoteIs = vi.fn(() => ({ select }));
    const sentIs = vi.fn(() => ({ is: quoteIs }));
    const eqOperator = vi.fn(() => ({ is: sentIs }));
    const eqId = vi.fn(() => ({ eq: eqOperator }));
    const update = vi.fn(() => ({ eq: eqId }));
    sbRef.current = { from: vi.fn(() => ({ update })) };

    await expect(
      linkQuoteBuildSession({ timerId: TIMER_ID, quoteId: QUOTE_ID, operatorId: OPERATOR_ID }),
    ).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith({ quote_id: QUOTE_ID });
    expect(eqId).toHaveBeenCalledWith('id', TIMER_ID);
    expect(eqOperator).toHaveBeenCalledWith('started_by', OPERATOR_ID);
    expect(sentIs).toHaveBeenCalledWith('sent_at', null);
    expect(quoteIs).toHaveBeenCalledWith('quote_id', null);
  });

  it('never reassigns a timer that is already linked to another quote', async () => {
    const OTHER_QUOTE_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const updateMaybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const updateSelect = vi.fn(() => ({ abortSignal: () => ({ maybeSingle: updateMaybeSingle }) }));
    const quoteIs = vi.fn(() => ({ select: updateSelect }));
    const sentIs = vi.fn(() => ({ is: quoteIs }));
    const eqOperator = vi.fn(() => ({ is: sentIs }));
    const eqId = vi.fn(() => ({ eq: eqOperator }));
    const update = vi.fn(() => ({ eq: eqId }));
    const readMaybeSingle = vi.fn(async () => ({
      data: row({ quote_id: OTHER_QUOTE_ID, sent_at: null }),
      error: null,
    }));
    const readAbortSignal = vi.fn(() => ({ maybeSingle: readMaybeSingle }));
    const readEq = vi.fn(() => ({ abortSignal: readAbortSignal }));
    const select = vi.fn(() => ({ eq: readEq }));
    sbRef.current = { from: vi.fn(() => ({ update, select })) };

    await expect(
      linkQuoteBuildSession({ timerId: TIMER_ID, quoteId: QUOTE_ID, operatorId: OPERATOR_ID }),
    ).resolves.toBe(false);
    expect(quoteIs).toHaveBeenCalledWith('quote_id', null);
  });

  it('completes the quote-linked timer once at the supplied first-send timestamp, for the staffer who STARTED it', async () => {
    const maybeSingle = vi.fn(async () => ({ data: { id: TIMER_ID }, error: null }));
    const abortSignal = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn(() => ({ abortSignal }));
    const is = vi.fn(() => ({ select }));
    // completion now chains TWO .eq() calls: quote_id AND started_by, so the
    // session can only be closed by the staffer who started it.
    const eq = vi.fn();
    eq.mockImplementation(() => ({ is, eq }));
    const update = vi.fn(() => ({ eq }));
    sbRef.current = { from: vi.fn(() => ({ update })) };

    await expect(
      completeQuoteBuildSession({
        quoteId: QUOTE_ID,
        timerId: null,
        operatorId: OPERATOR_ID,
        sentAt: '2026-08-21T12:10:00.000Z',
      }),
    ).resolves.toBe(true);
    expect(update).toHaveBeenCalledWith({ sent_at: '2026-08-21T12:10:00.000Z' });
    expect(eq).toHaveBeenCalledWith('quote_id', QUOTE_ID);
    expect(eq).toHaveBeenCalledWith('started_by', OPERATOR_ID);
    expect(is).toHaveBeenCalledWith('sent_at', null);
  });

  // Admin and staff lenses, converging HIGH: completion used to match on
  // quote_id alone, so a second staffer sending a draft the first staffer had
  // started stamped the FIRST staffer's session with the SECOND staffer's send
  // time. /insights then credited or blamed the wrong named person silently.
  it('does NOT complete a session started by a DIFFERENT staffer, and records nothing rather than a wrong row', async () => {
    const from = vi.fn(() => {
      throw new Error('must not touch the table without an operator identity');
    });
    sbRef.current = { from };

    await expect(
      completeQuoteBuildSession({
        quoteId: QUOTE_ID,
        timerId: null,
        operatorId: null,
        sentAt: '2026-08-21T12:10:00.000Z',
      }),
    ).resolves.toBe(false);
    expect(from).not.toHaveBeenCalled();
  });

  it('requires the starting staff identity before an unlinked timer can be completed', async () => {
    const linkedMaybeSingle = vi.fn(async () => ({ data: null, error: null }));
    const fallbackMaybeSingle = vi.fn(async () => ({ data: { id: TIMER_ID }, error: null }));
    const eqArgs: Array<[string, string]> = [];
    let updateCount = 0;
    const from = vi.fn(() => ({
      update: () => {
        updateCount += 1;
        const maybeSingle = updateCount === 1 ? linkedMaybeSingle : fallbackMaybeSingle;
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          eq: vi.fn((column: string, value: string) => {
            eqArgs.push([column, value]);
            return chain;
          }),
          is: vi.fn(() => chain),
          select: vi.fn(() => ({ abortSignal: () => ({ maybeSingle }) })),
        });
        return chain;
      },
    }));
    sbRef.current = { from };

    await expect(
      completeQuoteBuildSession({
        quoteId: QUOTE_ID,
        timerId: TIMER_ID,
        operatorId: OPERATOR_ID,
        sentAt: '2026-08-21T12:10:00.000Z',
      }),
    ).resolves.toBe(true);
    expect(eqArgs).toContainEqual(['started_by', OPERATOR_ID]);
  });

  it('queues completion after the response instead of awaiting analytics in the send path', async () => {
    const maybeSingle = vi.fn(async () => ({ data: { id: TIMER_ID }, error: null }));
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      update: vi.fn(() => chain),
      eq: vi.fn(() => chain),
      is: vi.fn(() => chain),
      select: vi.fn(() => chain),
      abortSignal: vi.fn(() => ({ maybeSingle })),
    });
    const from = vi.fn(() => chain);
    sbRef.current = { from };

    queueQuoteBuildSessionCompletion({
      quoteId: QUOTE_ID,
      timerId: TIMER_ID,
      sentAt: '2026-08-21T12:10:00.000Z',
    });

    expect(afterCallbacks).toHaveLength(1);
    expect(from).not.toHaveBeenCalled();
    await afterCallbacks[0]();
    expect(getOperatorMock).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledWith('quote_build_sessions');
  });
});

describe('listQuoteBuildTimingStats', () => {
  it('fails closed before touching service-role data when no operator is authenticated', async () => {
    const from = vi.fn();
    sbRef.current = { from };

    await expect(listQuoteBuildTimingStats(null)).resolves.toEqual({
      ok: false,
      error: 'Unauthorized',
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('returns a visible error result when the service-role read throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    sbRef.current = {
      from: () => ({
        select: () => ({
          not: () => ({
            order: () => ({
              order: () => ({
                range: () => ({
                  abortSignal: () => {
                    throw new Error('network down');
                  },
                }),
              }),
            }),
          }),
        }),
      }),
    };

    await expect(listQuoteBuildTimingStats({ id: OPERATOR_ID })).resolves.toEqual({
      ok: false,
      error: 'network down',
    });
    consoleSpy.mockRestore();
  });

  it('loads completed rows through the authenticated service-role path and aggregates them', async () => {
    const query: Record<string, unknown> = {};
    const not = vi.fn(() => query);
    const order = vi.fn(() => query);
    const range = vi.fn(() => query);
    const abortSignal = vi.fn(async () => ({ data: [row()], error: null }));
    Object.assign(query, { not, order, range, abortSignal });
    const select = vi.fn(() => query);
    const from = vi.fn(() => ({ select }));
    sbRef.current = { from };

    await expect(listQuoteBuildTimingStats({ id: OPERATOR_ID })).resolves.toEqual({
      ok: true,
      stats: [
        {
          operatorId: OPERATOR_ID,
          operatorLabel: 'Alex',
          count: 1,
          averageSeconds: 600,
          medianSeconds: 600,
          p90Seconds: 600,
          excludedCount: 0,
        },
      ],
    });
    expect(from).toHaveBeenCalledWith('quote_build_sessions');
    expect(not).toHaveBeenCalledWith('sent_at', 'is', null);
  });
});
