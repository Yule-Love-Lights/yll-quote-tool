// fleetDay: the fleet page's data assembly (row 403; fleet page rework 2026-08-28).
//
// Pins three behaviors the page depends on:
// 1. The crew clock lists the FIELD group only. Office staff clock in from the
//    same header widget, but the fleet page is about the people in the vans —
//    Naldo's call, 2026-08-28 ("only supposed to be me and the crew").
//    A shift whose crew row cannot be found stays VISIBLE as '(unknown)':
//    payroll rows are never hidden by a failed lookup, only by a positive
//    is_office=true.
// 2. A visit with no exit is attached to its vehicle as openVisit, so the page
//    can show "At Depot · N min" on the live tile.
// 3. listFleetDays returns distinct ET days, newest first, from both clocks.

import { describe, expect, it, vi, beforeEach } from 'vitest';

type Resp = { data: unknown; error: { message: string } | null };

// A thenable query chain: every builder method returns itself, and awaiting it
// (or calling .returns()) resolves the queued response for its table.
function chain(resp: Resp) {
  const c: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'gte', 'lt', 'is', 'order', 'limit']) {
    c[m] = vi.fn(() => c);
  }
  c.returns = vi.fn(() => Promise.resolve(resp));
  c.then = (resolve: (r: Resp) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(resp).then(resolve, reject);
  return c;
}

const tables: Record<string, Resp[]> = {};

function queue(table: string, resp: Resp) {
  (tables[table] ??= []).push(resp);
}

const fakeSb = {
  from: vi.fn((table: string) => {
    const next = tables[table]?.shift();
    return chain(next ?? { data: [], error: null });
  }),
};

vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => fakeSb,
}));

import { loadFleetDay, listFleetDays } from './fleetDay';

const DAY = '2026-08-28';

function seedEmptyVehiclesAndVisits() {
  queue('vehicles', { data: [], error: null });
  queue('vehicle_visits', { data: [], error: null });
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  fakeSb.from.mockClear();
});

describe('loadFleetDay crew clock', () => {
  it('shows field crew and excludes office staff', async () => {
    seedEmptyVehiclesAndVisits();
    queue('shifts', {
      data: [
        { crew_member_id: 'c-field', clock_in_at: `${DAY}T11:01:00Z`, clock_out_at: null },
        { crew_member_id: 'c-office', clock_in_at: `${DAY}T12:00:00Z`, clock_out_at: null },
      ],
      error: null,
    });
    queue('crew_members', {
      data: [
        { id: 'c-field', display_name: 'SonSon', is_office: false },
        { id: 'c-office', display_name: 'Kelly', is_office: true },
      ],
      error: null,
    });

    const day = await loadFleetDay(DAY);
    expect(day.shifts.map((s) => s.crewName)).toEqual(['SonSon']);
  });

  it('keeps a shift whose crew row is missing, as (unknown)', async () => {
    seedEmptyVehiclesAndVisits();
    queue('shifts', {
      data: [{ crew_member_id: 'c-ghost', clock_in_at: `${DAY}T11:01:00Z`, clock_out_at: null }],
      error: null,
    });
    queue('crew_members', { data: [], error: null });

    const day = await loadFleetDay(DAY);
    expect(day.shifts).toHaveLength(1);
    expect(day.shifts[0].crewName).toBe('(unknown)');
  });
});

describe('loadFleetDay open visit', () => {
  const VEHICLE = {
    id: 'v-1',
    label: 'Van',
    last_lat: 40.71,
    last_lng: -73.4,
    last_seen_at: new Date().toISOString(),
  };

  it('attaches the open visit to its vehicle', async () => {
    queue('vehicles', { data: [VEHICLE], error: null });
    queue('vehicle_visits', {
      data: [
        {
          vehicle_id: 'v-1',
          kind: 'depot',
          job_id: null,
          entered_at: `${DAY}T10:50:00Z`,
          exited_at: null,
          below_min_dwell: null,
        },
      ],
      error: null,
    });
    queue('shifts', { data: [], error: null });

    const day = await loadFleetDay(DAY);
    expect(day.vehicles[0].openVisit).toMatchObject({ kind: 'depot', enteredAt: `${DAY}T10:50:00Z` });
  });

  it('leaves openVisit null when every visit has an exit', async () => {
    queue('vehicles', { data: [VEHICLE], error: null });
    queue('vehicle_visits', {
      data: [
        {
          vehicle_id: 'v-1',
          kind: 'depot',
          job_id: null,
          entered_at: `${DAY}T10:50:00Z`,
          exited_at: `${DAY}T11:09:00Z`,
          below_min_dwell: null,
        },
      ],
      error: null,
    });
    queue('shifts', { data: [], error: null });

    const day = await loadFleetDay(DAY);
    expect(day.vehicles[0].openVisit).toBeNull();
  });
});

describe('listFleetDays', () => {
  it('returns distinct ET days from both clocks, newest first', async () => {
    // 2026-08-28T01:30Z is Aug 27 ET (21:30 the previous evening), so it
    // dedupes into the 27th rather than adding a fourth day.
    queue('vehicle_visits', {
      data: [{ entered_at: '2026-08-28T11:00:00Z' }, { entered_at: '2026-08-28T01:30:00Z' }],
      error: null,
    });
    queue('shifts', {
      data: [{ crew_member_id: 'c-field', clock_in_at: '2026-08-26T12:00:00Z' }],
      error: null,
    });
    queue('crew_members', { data: [{ id: 'c-field', is_office: false }], error: null });

    const days = await listFleetDays();
    expect(days).toEqual(['2026-08-28', '2026-08-27', '2026-08-26']);
  });

  it('skips a day whose only activity is office clock-ins', async () => {
    queue('vehicle_visits', { data: [], error: null });
    queue('shifts', {
      data: [
        { crew_member_id: 'c-office', clock_in_at: '2026-08-26T12:00:00Z' },
        { crew_member_id: 'c-field', clock_in_at: '2026-08-25T12:00:00Z' },
      ],
      error: null,
    });
    queue('crew_members', {
      data: [
        { id: 'c-office', is_office: true },
        { id: 'c-field', is_office: false },
      ],
      error: null,
    });

    const days = await listFleetDays();
    expect(days).toEqual(['2026-08-25']);
  });
});
