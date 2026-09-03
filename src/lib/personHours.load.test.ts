// Direct tests for `loadPersonTime` — the loader itself, not the pure helpers
// that `personHours.test.ts` already covers.
//
// WHY THIS FILE EXISTS. Phase 4 gave `loadPersonTime` a `withSettlements`
// option so the staff self-view can skip the settlement read entirely. The
// pre-merge technical lens pointed out that the whole branch had ZERO direct
// coverage: `personHours.test.ts` never calls the loader, and the page test
// mocks it out. Today's blast radius is nil (the only consumer of a wrong
// `settlementId` is the admin-only controls block), but a future edit to this
// branch would have shipped silently, which is exactly the class this repo
// keeps getting bitten by. The three properties pinned here are:
//
//   1. by default the settlement read HAPPENS and its answer reaches the rows;
//   2. with `withSettlements: false` it does not happen AT ALL, and no row
//      claims to be paid or unpaid;
//   3. a FAILED settlement read is reported as unreadable, which is what makes
//      the admin pay panel hide rather than offer to pay a shift twice.
//
// The fake database is a thenable query builder rather than a full fake DB:
// every read here is one `select ... range()` page, and modelling more would
// be modelling supabase-js rather than this module.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { settledShiftIdsMock, serviceClientMock } = vi.hoisted(() => ({
  settledShiftIdsMock: vi.fn(),
  serviceClientMock: vi.fn(),
}));

vi.mock('@/lib/shiftSettlements', () => ({ settledShiftIds: settledShiftIdsMock }));
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: serviceClientMock }));

import { loadPersonTime } from './personHours';

const NOW = '2026-09-02T14:00:00.000Z';

const PERSON = {
  id: 'crew-1',
  display_name: 'Khaye',
  active: true,
  is_office: true,
  base_rate_cents: 2500,
};

const SHIFT_A = {
  id: 'shift-a',
  clock_in_at: '2026-09-01T13:00:00.000Z',
  clock_out_at: '2026-09-01T21:00:00.000Z',
  source: 'office',
  close_source: 'office',
  manual_by: null,
};

/**
 * One table's answer. Every chainable method returns the builder; `range`
 * resolves the first page and an empty second one, which is how the loader's
 * paging loop terminates.
 */
function table(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'order']) {
    builder[method] = () => builder;
  }
  builder.range = (from: number) =>
    Promise.resolve({ data: from === 0 ? rows : [], error: null });
  builder.maybeSingle = () => Promise.resolve({ data: rows[0] ?? null, error: null });
  return builder;
}

function fakeDb(shifts: unknown[] = [SHIFT_A]) {
  const tables: Record<string, unknown> = {
    crew_members: table([PERSON]),
    shifts: table(shifts),
    shift_breaks: table([]),
    dashboard_activity: table([]),
  };
  return {
    from: (name: string) => {
      const t = tables[name];
      // Loud rather than undefined: a new read added to the loader should
      // fail this file, not silently resolve to nothing.
      if (!t) throw new Error(`unexpected table ${name}`);
      return t;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceClientMock.mockReturnValue(fakeDb());
  settledShiftIdsMock.mockResolvedValue(new Map([['shift-a', 'settlement-1']]));
});

describe('loadPersonTime — the settlement read', () => {
  it('reads settlements by default, and stamps the paid shift', async () => {
    const time = await loadPersonTime('crew-1', 'all', NOW);

    expect(settledShiftIdsMock).toHaveBeenCalledTimes(1);
    expect(settledShiftIdsMock.mock.calls[0][0]).toEqual(['shift-a']);
    expect(time.settlementsReadable).toBe(true);
    expect(time.days[0].shifts[0].settlementId).toBe('settlement-1');
  });

  it('does not read settlements at all when the caller opts out', async () => {
    const time = await loadPersonTime('crew-1', 'all', NOW, { withSettlements: false });

    // Not "read and ignored" — never called. This is what keeps the staff
    // self-view from touching the payment tables at all.
    expect(settledShiftIdsMock).not.toHaveBeenCalled();
    // False means "do not draw a paid/unpaid claim from this", which is the
    // safe direction: not-looked-up and looked-up-and-broke are the same
    // answer to "is this shift paid".
    expect(time.settlementsReadable).toBe(false);
    expect(time.days[0].shifts[0].settlementId).toBeNull();
    // And the hours themselves are untouched by the opt-out.
    expect(time.totalSeconds).toBe(8 * 3600);
    expect(time.shiftCount).toBe(1);
    expect(time.errors).toEqual([]);
  });

  it('reports a FAILED settlement read as unreadable, and says so in words', async () => {
    settledShiftIdsMock.mockRejectedValue(new Error('shift_settlement_lines: boom'));

    const time = await loadPersonTime('crew-1', 'all', NOW);

    expect(time.settlementsReadable).toBe(false);
    expect(time.days[0].shifts[0].settlementId).toBeNull();
    expect(time.errors.join(' ')).toContain('shift_settlement_lines: boom');
    expect(time.errors.join(' ')).toContain('payments could not be read');
    // The hours survive a settlement failure: only the pay panel hides.
    expect(time.totalSeconds).toBe(8 * 3600);
  });

  it('opts out cleanly for a person with no shifts at all', async () => {
    serviceClientMock.mockReturnValue(fakeDb([]));

    const time = await loadPersonTime('crew-1', 'all', NOW, { withSettlements: false });

    expect(settledShiftIdsMock).not.toHaveBeenCalled();
    expect(time.person?.displayName).toBe('Khaye');
    expect(time.days).toEqual([]);
    expect(time.totalSeconds).toBe(0);
    expect(time.errors).toEqual([]);
  });
});
