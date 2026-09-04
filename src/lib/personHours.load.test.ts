// Direct tests for `loadPersonTime` — the loader itself, not the pure helpers
// that `personHours.test.ts` already covers.
//
// WHY THIS FILE EXISTS. The pre-merge technical lens pointed out that the
// loader itself had ZERO direct coverage: `personHours.test.ts` never calls
// it, and the page tests mock it out, so the settlement read and its failure
// path shipped untested. Both pages now depend on that read to say who has
// been paid, so a wrong answer here is a staff member told they are owed for
// hours they were already paid for. The properties pinned here are:
//
//   1. the settlement read happens, and its answer reaches the rows;
//   2. a FAILED read is reported as unreadable and leaves EVERY row unstamped
//      — which is what makes the admin pay panel hide and the staff self-view
//      drop its markers, rather than either page claiming "unpaid";
//   3. the hours themselves survive a settlement failure untouched.
//
// The fake database is a thenable query builder rather than a full fake DB:
// every read here is one `select ... range()` page, and modelling more would
// be modelling supabase-js rather than this module.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { settledSecondsMock, serviceClientMock } = vi.hoisted(() => ({
  settledSecondsMock: vi.fn(),
  serviceClientMock: vi.fn(),
}));

vi.mock('@/lib/shiftSettlements', () => ({ settledSecondsByShift: settledSecondsMock }));
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
  settledSecondsMock.mockResolvedValue(
    new Map([['shift-a', { seconds: 8 * 3600, settlementId: 'settlement-1' }]]),
  );
});

describe('loadPersonTime — the settlement read', () => {
  it('reads settlements by default, and stamps the paid shift', async () => {
    const time = await loadPersonTime('crew-1', 'all', NOW);

    expect(settledSecondsMock).toHaveBeenCalledTimes(1);
    expect(settledSecondsMock.mock.calls[0][0]).toEqual(['shift-a']);
    expect(time.settlementsReadable).toBe(true);
    expect(time.days[0].shifts[0].settlementId).toBe('settlement-1');
    // The whole shift is 8h and the whole 8h is covered.
    expect(time.days[0].shifts[0].settledSeconds).toBe(8 * 3600);
  });

  it('leaves a shift no settlement covers unstamped', async () => {
    settledSecondsMock.mockResolvedValue(new Map());

    const time = await loadPersonTime('crew-1', 'all', NOW);

    expect(time.settlementsReadable).toBe(true);
    expect(time.days[0].shifts[0].settlementId).toBeNull();
    expect(time.days[0].shifts[0].settledSeconds).toBe(0);
    expect(time.errors).toEqual([]);
  });

  it('carries a PART payment through as seconds, not as a yes/no', async () => {
    settledSecondsMock.mockResolvedValue(
      new Map([['shift-a', { seconds: 3 * 3600, settlementId: 'settlement-1' }]]),
    );
    const time = await loadPersonTime('crew-1', 'all', NOW);
    expect(time.days[0].shifts[0].settledSeconds).toBe(3 * 3600);
    // Still locked: any live payment refuses an edit, half or whole.
    expect(time.days[0].shifts[0].settlementId).toBe('settlement-1');
    expect(time.days[0].shifts[0].removable).toBe(false);
  });

  it('reports a FAILED settlement read as unreadable, and says so in words', async () => {
    settledSecondsMock.mockRejectedValue(new Error('shift_settlement_lines: boom'));

    const time = await loadPersonTime('crew-1', 'all', NOW);

    expect(time.settlementsReadable).toBe(false);
    expect(time.days[0].shifts[0].settlementId).toBeNull();
    expect(time.errors.join(' ')).toContain('shift_settlement_lines: boom');
    // The message has to be true on BOTH pages that render it: the admin
    // record, where a payment could otherwise be recorded, and the staff
    // self-view, where nothing ever could.
    expect(time.errors.join(' ')).toContain('nothing here says paid or unpaid');
    // The hours survive a settlement failure: only the pay panel hides.
    expect(time.totalSeconds).toBe(8 * 3600);
  });

  it('reads a person with no shifts at all without asking about settlements', async () => {
    serviceClientMock.mockReturnValue(fakeDb([]));

    const time = await loadPersonTime('crew-1', 'all', NOW);

    // settledShiftIds short-circuits on an empty id list, so this is the one
    // case where no read happens and the answer is still trustworthy.
    expect(settledSecondsMock).toHaveBeenCalledWith([]);
    expect(time.person?.displayName).toBe('Khaye');
    expect(time.days).toEqual([]);
    expect(time.totalSeconds).toBe(0);
    expect(time.errors).toEqual([]);
  });
});
