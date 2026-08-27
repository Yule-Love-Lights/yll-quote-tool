// The GPS visit timeline — the second clock.
//
// The constraint these tests protect: this file writes visits and NOTHING else.
// It must never reach `shifts` or `job_segments`. Row 403 constraint (a).

import { describe, it, expect, beforeEach, vi } from 'vitest';

type MockTables = {
  zone: null | { id: string; kind: 'job' | 'depot'; job_id: string | null };
  vehicle: null | { id: string };
  openVisit: null | { id: string };
  insertError: null | { code?: string; message: string };
  updateError: null | { message: string };
  inserted: Record<string, unknown>[];
  updated: Record<string, unknown>[];
  touched: string[];
};

const { tables, getSupabaseServiceClient } = vi.hoisted(() => {
  const tables: MockTables = {
    zone: null,
    vehicle: null,
    openVisit: null,
    insertError: null,
    updateError: null,
    inserted: [],
    updated: [],
    touched: [],
  };
  const getSupabaseServiceClient = vi.fn(() => ({
    from: (table: string) => {
      tables.touched.push(table);
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self,
        eq: self,
        is: self,
        order: self,
        limit: self,
        returns: async () => {
          if (table === 'job_geozones') return { data: tables.zone ? [tables.zone] : [] };
          if (table === 'vehicles') return { data: tables.vehicle ? [tables.vehicle] : [] };
          return { data: tables.openVisit ? [tables.openVisit] : [] };
        },
        insert: (row: Record<string, unknown>) => {
          tables.inserted.push(row);
          return {
            select: () => ({
              returns: async () => ({
                data: tables.insertError ? null : [{ id: 'visit-1' }],
                error: tables.insertError,
              }),
            }),
          };
        },
        update: (row: Record<string, unknown>) => {
          tables.updated.push(row);
          const u: Record<string, unknown> = {};
          Object.assign(u, {
            eq: () => u,
            is: async () => ({ error: tables.updateError }),
          });
          return u;
        },
      });
      return chain;
    },
  }));
  return { tables, getSupabaseServiceClient };
});

vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient }));

import { parseGeozoneEvent, recordGeozoneVisit } from './vehicleVisits';

beforeEach(() => {
  tables.zone = { id: 'zone-row-1', kind: 'job', job_id: 'job-1' };
  tables.vehicle = { id: 'veh-1' };
  tables.openVisit = null;
  tables.insertError = null;
  tables.updateError = null;
  tables.inserted = [];
  tables.updated = [];
  tables.touched = [];
});

function geozonePayload(over: Record<string, unknown> = {}, zoneOver: Record<string, unknown> = {}) {
  return {
    eventType: 'applicationGeozone',
    imei: '865612075879763',
    vin: 'VIN',
    geozone: {
      id: 'bouncie-zone-1',
      name: '12 Elm St',
      event: 'ENTER',
      timestamp: '2026-08-27T14:00:00.000Z',
      location: { lat: 40.7, lon: -73.5, heading: 90 },
      ...zoneOver,
    },
    ...over,
  };
}

describe('parseGeozoneEvent', () => {
  it('reads a geofence entry', () => {
    expect(parseGeozoneEvent(geozonePayload(), 'evt-1', null)).toEqual({
      bouncieGeozoneId: 'bouncie-zone-1',
      direction: 'ENTER',
      imei: '865612075879763',
      occurredAt: '2026-08-27T14:00:00.000Z',
      eventId: 'evt-1',
    });
  });

  it('reads an exit', () => {
    expect(parseGeozoneEvent(geozonePayload({}, { event: 'EXIT' }), 'e', null)?.direction).toBe('EXIT');
  });

  it('accepts userGeozone as well as applicationGeozone', () => {
    expect(parseGeozoneEvent(geozonePayload({ eventType: 'userGeozone' }), 'e', null)).not.toBeNull();
  });

  it('returns null for a non-geofence event rather than guessing', () => {
    expect(parseGeozoneEvent({ eventType: 'tripStart', start: {} }, 'e', null)).toBeNull();
  });

  it('returns null for junk, and never throws', () => {
    for (const junk of [null, undefined, 'string', 42, []]) {
      expect(parseGeozoneEvent(junk, 'e', null)).toBeNull();
    }
  });

  it('returns null on an unrecognised direction, instead of assuming arrival', () => {
    // Inventing an ENTER would create a visit that never happened.
    expect(parseGeozoneEvent(geozonePayload({}, { event: 'SOMETHING' }), 'e', null)).toBeNull();
    expect(parseGeozoneEvent(geozonePayload({}, { event: '' }), 'e', null)).toBeNull();
  });

  it('falls back to the receiver-parsed time when the zone carries none', () => {
    const facts = parseGeozoneEvent(geozonePayload({}, { timestamp: undefined }), 'e', '2026-08-27T15:00:00.000Z');
    expect(facts?.occurredAt).toBe('2026-08-27T15:00:00.000Z');
  });

  it('returns null when there is no usable time at all', () => {
    // A visit with no time would produce a meaningless duration.
    expect(parseGeozoneEvent(geozonePayload({}, { timestamp: undefined }), 'e', null)).toBeNull();
    expect(parseGeozoneEvent(geozonePayload({}, { timestamp: 'not-a-date' }), 'e', null)).toBeNull();
  });

  it('returns null without a zone id or an imei', () => {
    expect(parseGeozoneEvent(geozonePayload({}, { id: '' }), 'e', null)).toBeNull();
    expect(parseGeozoneEvent(geozonePayload({ imei: '' }), 'e', null)).toBeNull();
  });
});

describe('recordGeozoneVisit', () => {
  const enter = { bouncieGeozoneId: 'z', direction: 'ENTER' as const, imei: '1', occurredAt: '2026-08-27T14:00:00.000Z', eventId: 'evt-1' };
  const exit = { ...enter, direction: 'EXIT' as const, occurredAt: '2026-08-27T16:30:00.000Z', eventId: 'evt-2' };

  it('opens a visit on ENTER, carrying the job and the source event', async () => {
    expect(await recordGeozoneVisit(enter)).toEqual({ action: 'opened', visitId: 'visit-1' });
    expect(tables.inserted[0]).toMatchObject({
      vehicle_id: 'veh-1',
      geozone_id: 'zone-row-1',
      kind: 'job',
      job_id: 'job-1',
      entered_at: '2026-08-27T14:00:00.000Z',
      enter_event_id: 'evt-1',
    });
  });

  it('closes the open visit on EXIT', async () => {
    tables.openVisit = { id: 'visit-1' };
    expect(await recordGeozoneVisit(exit)).toEqual({ action: 'closed', visitId: 'visit-1' });
    expect(tables.updated[0]).toMatchObject({ exited_at: '2026-08-27T16:30:00.000Z', exit_event_id: 'evt-2' });
  });

  it('treats a redelivered ENTER as already handled, not as an error', async () => {
    // Bouncie documents duplicate delivery as normal.
    tables.insertError = { code: '23505', message: 'duplicate key' };
    expect(await recordGeozoneVisit(enter)).toEqual({ action: 'ignored', reason: 'duplicate enter' });
  });

  it('ignores a zone we do not track', async () => {
    // Retired zones, and zones the vehicle owner made in their own Bouncie app.
    tables.zone = null;
    expect(await recordGeozoneVisit(enter)).toEqual({ action: 'ignored', reason: 'unknown geozone' });
  });

  it('ignores a device that is not a registered vehicle', async () => {
    tables.vehicle = null;
    expect(await recordGeozoneVisit(enter)).toEqual({ action: 'ignored', reason: 'unregistered vehicle' });
  });

  it('DROPS an exit with no matching arrival rather than inventing a duration', async () => {
    // Real case: the zone was armed while the van was already inside it. A visit
    // with no entry time would produce a made-up length for the job.
    tables.openVisit = null;
    expect(await recordGeozoneVisit(exit)).toEqual({ action: 'ignored', reason: 'exit without an open visit' });
    expect(tables.updated).toHaveLength(0);
  });

  it('records a depot visit with no job attached', async () => {
    tables.zone = { id: 'depot-row', kind: 'depot', job_id: null };
    await recordGeozoneVisit(enter);
    expect(tables.inserted[0]).toMatchObject({ kind: 'depot', job_id: null });
  });

  it('surfaces a real insert failure as ignored-with-a-reason, not as success', async () => {
    tables.insertError = { code: '08006', message: 'connection reset' };
    const out = await recordGeozoneVisit(enter);
    expect(out).toMatchObject({ action: 'ignored' });
    expect((out as { reason: string }).reason).toMatch(/insert failed/);
  });

  // ROW 403 CONSTRAINT (a).
  it('NEVER touches shifts or job_segments', async () => {
    tables.openVisit = { id: 'visit-1' };
    await recordGeozoneVisit(enter);
    await recordGeozoneVisit(exit);
    expect(tables.touched).not.toContain('shifts');
    expect(tables.touched).not.toContain('job_segments');
    expect(new Set(tables.touched)).toEqual(new Set(['job_geozones', 'vehicles', 'vehicle_visits']));
  });
});
