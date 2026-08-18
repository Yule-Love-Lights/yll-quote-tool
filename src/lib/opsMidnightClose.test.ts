import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ShiftRow = {
  id: string;
  crew_member_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  close_source: string | null;
};

const { stateRef, dbRef } = vi.hoisted(() => ({
  dbRef: { current: null as unknown },
  stateRef: {
    current: {
      shifts: [] as ShiftRow[],
      scanError: null as { message: string } | null,
      breakClosed: [] as Array<{ shiftId: string; at: string; source: string }>,
      segmentClosed: [] as Array<{ shiftId: string; at: string; source: string }>,
      breakThrows: false,
      openBreakShifts: new Set<string>(),
      openSegmentShifts: new Set<string>(),
    },
  },
}));

vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => dbRef.current }));

vi.mock('@/lib/shiftBreaks', () => ({
  closeOpenBreakForShift: async (shiftId: string, at: string, source: string) => {
    if (stateRef.current.breakThrows) throw new Error('break boom');
    if (!stateRef.current.openBreakShifts.has(shiftId)) return null;
    stateRef.current.openBreakShifts.delete(shiftId); // guarded: only once
    stateRef.current.breakClosed.push({ shiftId, at, source });
    return { id: 'brk' };
  },
}));

vi.mock('@/lib/jobSegments', () => ({
  closeOpenSegmentForShift: async (shiftId: string, at: string, source: string) => {
    if (!stateRef.current.openSegmentShifts.has(shiftId)) return null;
    stateRef.current.openSegmentShifts.delete(shiftId);
    stateRef.current.segmentClosed.push({ shiftId, at, source });
    return { id: 'seg' };
  },
}));

function makeDb() {
  return {
    from(table: string) {
      if (table !== 'shifts') throw new Error(`unexpected table ${table}`);
      const b = {
        select: () => b,
        is: () => b,
        then: (resolve: (v: unknown) => unknown) =>
          resolve({
            data: stateRef.current.scanError
              ? null
              : stateRef.current.shifts.filter((s) => s.clock_out_at === null),
            error: stateRef.current.scanError,
          }),
        update: (payload: Record<string, unknown>) => {
          const f: Record<string, unknown> = {};
          const ub = {
            eq: (c: string, v: unknown) => {
              f[c] = v;
              return ub;
            },
            is: (c: string, v: unknown) => {
              f[c] = v;
              return ub;
            },
            select: () => ({
              maybeSingle: async () => {
                const i = stateRef.current.shifts.findIndex((s) =>
                  Object.entries(f).every(
                    ([k, v]) => (s as unknown as Record<string, unknown>)[k] === v,
                  ),
                );
                if (i === -1) return { data: null, error: null };
                stateRef.current.shifts[i] = {
                  ...stateRef.current.shifts[i],
                  ...payload,
                } as ShiftRow;
                return { data: { id: stateRef.current.shifts[i]!.id }, error: null };
              },
            }),
          };
          return ub;
        },
      };
      return b;
    },
  };
}

beforeEach(() => {
  stateRef.current = {
    shifts: [],
    scanError: null,
    breakClosed: [],
    segmentClosed: [],
    breakThrows: false,
    openBreakShifts: new Set(),
    openSegmentShifts: new Set(),
  };
  dbRef.current = makeDb();
});

afterEach(() => vi.restoreAllMocks());

import { closeForgottenDays, etMidnightAfter, isStaleForEtDay } from './opsMidnightClose';

// ---------------------------------------------------------------------------
// The ET day boundary. This is the part a UTC bug would silently ruin.
// ---------------------------------------------------------------------------

describe('etMidnightAfter', () => {
  it('summer (EDT, UTC-4): midnight after a July afternoon is 04:00Z next day', () => {
    expect(etMidnightAfter(new Date('2026-07-15T18:00:00Z')).toISOString()).toBe(
      '2026-07-16T04:00:00.000Z',
    );
  });

  it('winter (EST, UTC-5): midnight after a January afternoon is 05:00Z next day', () => {
    expect(etMidnightAfter(new Date('2026-01-15T18:00:00Z')).toISOString()).toBe(
      '2026-01-16T05:00:00.000Z',
    );
  });

  it('a late-evening ET punch belongs to that ET day, not the next UTC one', () => {
    // 2026-07-15 23:30 ET is 2026-07-16 03:30 UTC. Using the UTC date would
    // roll the day forward and close it 24 hours late.
    const lateEt = new Date('2026-07-16T03:30:00Z');
    expect(etMidnightAfter(lateEt).toISOString()).toBe('2026-07-16T04:00:00.000Z');
  });

  it('handles the spring-forward day (2026-03-08) without landing in the gap', () => {
    // The day itself starts EST and ends EDT; midnight AFTER it is EDT.
    expect(etMidnightAfter(new Date('2026-03-08T18:00:00Z')).toISOString()).toBe(
      '2026-03-09T04:00:00.000Z',
    );
  });

  it('handles the fall-back day (2026-11-01)', () => {
    expect(etMidnightAfter(new Date('2026-11-01T18:00:00Z')).toISOString()).toBe(
      '2026-11-02T05:00:00.000Z',
    );
  });

  it('crosses a month and a year boundary correctly', () => {
    expect(etMidnightAfter(new Date('2026-01-31T18:00:00Z')).toISOString()).toBe(
      '2026-02-01T05:00:00.000Z',
    );
    expect(etMidnightAfter(new Date('2026-12-31T18:00:00Z')).toISOString()).toBe(
      '2027-01-01T05:00:00.000Z',
    );
  });
});

describe('isStaleForEtDay', () => {
  const now = new Date('2026-07-16T14:00:00Z'); // 10:00 ET on the 16th

  it('a shift opened yesterday ET is stale', () => {
    expect(isStaleForEtDay('2026-07-15T18:00:00Z', now)).toBe(true);
  });

  it("today's shift is NOT stale, however long it has been open", () => {
    expect(isStaleForEtDay('2026-07-16T11:00:00Z', now)).toBe(false);
  });

  it('a late-evening ET shift is judged on the ET day, not the UTC one', () => {
    // 2026-07-16 03:30Z is still 2026-07-15 ET, so relative to the 16th it IS
    // stale. A UTC comparison would call it "today" and leave it open.
    expect(isStaleForEtDay('2026-07-16T03:30:00Z', now)).toBe(true);
  });

  it('treats an unparseable timestamp as stale rather than leaving it open forever', () => {
    expect(isStaleForEtDay('not-a-date', now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The sweep.
// ---------------------------------------------------------------------------

const NOW = new Date('2026-07-16T14:00:00Z');

const shift = (id: string, clockInAt: string, clockOutAt: string | null = null): ShiftRow => ({
  id,
  crew_member_id: `crew-${id}`,
  clock_in_at: clockInAt,
  clock_out_at: clockOutAt,
  close_source: null,
});

describe('closeForgottenDays', () => {
  it('closes a forgotten shift at ITS OWN day-end, not at now', () => {
    // The whole point: a shift forgotten days ago must not be paid for those days.
    stateRef.current.shifts = [shift('a', '2026-07-13T18:00:00Z')];
    return closeForgottenDays(NOW).then((r) => {
      expect(r.shiftsClosed).toBe(1);
      expect(stateRef.current.shifts[0]!.clock_out_at).toBe('2026-07-14T04:00:00.000Z');
      expect(stateRef.current.shifts[0]!.close_source).toBe('system');
    });
  });

  it("leaves today's open shift alone", async () => {
    stateRef.current.shifts = [shift('today', '2026-07-16T11:00:00Z')];
    const r = await closeForgottenDays(NOW);
    expect(r.scanned).toBe(0);
    expect(r.shiftsClosed).toBe(0);
    expect(stateRef.current.shifts[0]!.clock_out_at).toBeNull();
  });

  it('closes an open break and segment BEFORE the shift, at the same instant', async () => {
    stateRef.current.shifts = [shift('a', '2026-07-15T18:00:00Z')];
    stateRef.current.openBreakShifts.add('a');
    stateRef.current.openSegmentShifts.add('a');

    const r = await closeForgottenDays(NOW);

    expect(r.breaksClosed).toBe(1);
    expect(r.segmentsClosed).toBe(1);
    expect(r.shiftsClosed).toBe(1);
    const at = '2026-07-16T04:00:00.000Z';
    expect(stateRef.current.breakClosed).toEqual([{ shiftId: 'a', at, source: 'system' }]);
    expect(stateRef.current.segmentClosed).toEqual([{ shiftId: 'a', at, source: 'system' }]);
    expect(stateRef.current.shifts[0]!.clock_out_at).toBe(at);
  });

  it('is IDEMPOTENT — a second run closes nothing and moves no recorded time', async () => {
    stateRef.current.shifts = [shift('a', '2026-07-15T18:00:00Z')];
    stateRef.current.openBreakShifts.add('a');

    const first = await closeForgottenDays(NOW);
    const closedAt = stateRef.current.shifts[0]!.clock_out_at;

    const second = await closeForgottenDays(new Date('2026-07-20T14:00:00Z'));

    expect(first.shiftsClosed).toBe(1);
    expect(second.scanned).toBe(0);
    expect(second.shiftsClosed).toBe(0);
    expect(stateRef.current.shifts[0]!.clock_out_at).toBe(closedAt);
  });

  it('reports each closed shift id so a human can review it', async () => {
    stateRef.current.shifts = [
      shift('a', '2026-07-15T18:00:00Z'),
      shift('b', '2026-07-14T18:00:00Z'),
    ];
    const r = await closeForgottenDays(NOW);
    expect(r.shiftsClosed).toBe(2);
    expect(r.closedShiftIds.sort()).toEqual(['a', 'b']);
  });

  it('still closes the shift when a child close throws, and records the error', async () => {
    // A break-close hiccup must not leave the shift open forever — that would
    // block the crew member's next clock-in.
    stateRef.current.shifts = [shift('a', '2026-07-15T18:00:00Z')];
    stateRef.current.breakThrows = true;

    const r = await closeForgottenDays(NOW);

    expect(r.shiftsClosed).toBe(1);
    expect(r.errors.some((e) => e.includes('break close failed'))).toBe(true);
  });

  it('reports a scan failure instead of pretending there was nothing to do', async () => {
    stateRef.current.scanError = { message: 'connection terminated' };
    const r = await closeForgottenDays(NOW);
    expect(r.scanned).toBe(0);
    expect(r.errors[0]).toContain('connection terminated');
  });

  it('reports unconfigured Supabase rather than throwing', async () => {
    dbRef.current = null;
    const r = await closeForgottenDays(NOW);
    expect(r.errors[0]).toContain('not configured');
  });
});
