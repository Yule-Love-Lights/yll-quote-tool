// Bouncie geofence provisioning.
//
// The two things most worth pinning here are the coordinate order (a lat/lng
// swap produces a zone in the wrong hemisphere that simply never fires, with no
// error anywhere) and the refusal to invent a geofence for a property with no
// verified coordinate.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { bouncieFetch, db } = vi.hoisted(() => {
  const bouncieFetch = vi.fn(
    async (_path: string, _init?: { method?: string; body?: unknown; accountEmail?: string }) =>
      ({ ok: true, status: 200, json: async () => ({ id: 'remote-1' }) }) as unknown as Response,
  );
  const db = {
    vehicles: [] as { id: string; imei: string; label: string }[],
    assignments: [] as unknown[],
    existingZones: [] as { id: string }[],
    staleZones: [] as { id: string; bouncie_geozone_id: string; bouncie_location_id: string }[],
    inserted: [] as Record<string, unknown>[],
    updated: [] as Record<string, unknown>[],
    insertError: null as null | { message: string },
  };
  return { bouncieFetch, db };
});

vi.mock('@/lib/integrations/bouncieAuth', () => ({ bouncieFetch }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self, eq: self, is: self, not: self, lt: self, order: self, limit: self,
        returns: async () => {
          if (table === 'vehicles') return { data: db.vehicles };
          if (table === 'job_assignments') return { data: db.assignments };
          if (table === 'job_geozones') {
            return { data: db.staleZones.length ? db.staleZones : db.existingZones };
          }
          return { data: [] };
        },
        insert: (row: Record<string, unknown>) => {
          db.inserted.push(row);
          return Promise.resolve({ error: db.insertError });
        },
        update: (row: Record<string, unknown>) => {
          db.updated.push(row);
          const u: Record<string, unknown> = {};
          Object.assign(u, { eq: async () => ({ error: null }) });
          return u;
        },
      });
      return chain;
    },
  }),
}));

import {
  buildCircle,
  createLocation,
  createGeozone,
  deleteGeozone,
  armZonesForDate,
  retireZonesBefore,
  GEOFENCE_RADIUS_METRES,
  BouncieGeozoneError,
} from './bouncieGeozones';

beforeEach(() => {
  bouncieFetch.mockClear();
  bouncieFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'remote-1' }) } as unknown as Response);
  db.vehicles = [{ id: 'veh-1', imei: '865612075879763', label: 'Van' }];
  db.assignments = [];
  db.existingZones = [];
  db.staleZones = [];
  db.inserted = [];
  db.updated = [];
  db.insertError = null;
});

describe('buildCircle', () => {
  it('emits [longitude, latitude], NOT [lat, lng]', () => {
    // The single most dangerous detail in this file. Swapping produces a zone in
    // the wrong hemisphere that never fires, and nothing errors.
    const c = buildCircle(40.711038, -73.403885);
    expect(c.geometry.coordinates).toEqual([-73.403885, 40.711038]);
    expect(c.geometry.coordinates[0]).toBeLessThan(0); // longitude, western hemisphere
    expect(c.geometry.coordinates[1]).toBeGreaterThan(0); // latitude, northern
  });

  it('uses the shared radius by default', () => {
    expect(buildCircle(40.7, -73.5).properties.radius).toBe(GEOFENCE_RADIUS_METRES);
    expect(buildCircle(40.7, -73.5, 250).properties.radius).toBe(250);
  });

  it('is a GeoJSON Circle feature', () => {
    const c = buildCircle(40.7, -73.5);
    expect(c.type).toBe('Feature');
    expect(c.geometry.type).toBe('Point');
    expect(c.properties.subType).toBe('Circle');
  });

  it('REFUSES an out-of-range coordinate, which is what a lat/lng swap looks like', () => {
    // -73 as a latitude is legal, but 40.7 as a longitude with a real Long Island
    // longitude in the lat slot is not: catch the swap where it happens.
    expect(() => buildCircle(-73.403885, 40.711038)).not.toThrow(); // both in range, cannot be caught here
    expect(() => buildCircle(200, -73)).toThrow(BouncieGeozoneError);
    expect(() => buildCircle(40.7, 999)).toThrow(BouncieGeozoneError);
  });

  it('refuses a missing or non-numeric coordinate', () => {
    expect(() => buildCircle(NaN, -73.5)).toThrow(BouncieGeozoneError);
    expect(() => buildCircle(40.7, Number.POSITIVE_INFINITY)).toThrow(BouncieGeozoneError);
  });

  it('refuses a zero or negative radius', () => {
    expect(() => buildCircle(40.7, -73.5, 0)).toThrow(BouncieGeozoneError);
    expect(() => buildCircle(40.7, -73.5, -50)).toThrow(BouncieGeozoneError);
  });
});

describe('createLocation / createGeozone', () => {
  it('posts the circle and returns the id', async () => {
    expect(await createLocation('job-1', buildCircle(40.7, -73.5))).toBe('remote-1');
    const [path, init] = bouncieFetch.mock.calls[0]!;
    expect(path).toBe('/locations/');
    expect(init?.method).toBe('POST');
  });

  it('creates the geozone per DEVICE, with both events', async () => {
    await createGeozone('865612075879763', 'loc-1');
    const [path, init] = bouncieFetch.mock.calls[0]!;
    expect(path).toBe('/application-geozones/');
    expect(init?.body).toMatchObject({ imei: '865612075879763', locationId: 'loc-1', events: ['ENTER', 'EXIT'] });
  });

  it('accepts an id nested under location/geozone as well as at the top level', async () => {
    bouncieFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ location: { id: 'nested' } }) } as unknown as Response);
    expect(await createLocation('n', buildCircle(40.7, -73.5))).toBe('nested');
  });

  it('throws rather than returning an empty id', async () => {
    bouncieFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    await expect(createLocation('n', buildCircle(40.7, -73.5))).rejects.toThrow(/carried no id/);
  });

  it('surfaces a non-2xx', async () => {
    bouncieFetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) } as unknown as Response);
    await expect(createGeozone('1', 'l')).rejects.toThrow(/failed \(403\)/);
  });
});

describe('deleteGeozone', () => {
  it('tolerates a 404, since a zone already gone still needs retiring locally', async () => {
    bouncieFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
    await expect(deleteGeozone('z', 'l')).resolves.toBeUndefined();
  });

  it('throws on a real failure', async () => {
    bouncieFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    await expect(deleteGeozone('z', 'l')).rejects.toThrow(/failed \(500\)/);
  });
});

describe('armZonesForDate', () => {
  const withCoords = (jobId: string, lat: number | null, lng: number | null) => ({
    job_id: jobId,
    jobs: { property_id: 'p', properties: { lat, lng } },
  });

  it('arms one zone per vehicle for a job with a verified coordinate', async () => {
    db.vehicles = [
      { id: 'v1', imei: '111111111111111', label: 'Van' },
      { id: 'v2', imei: '222222222222222', label: 'Truck' },
    ];
    db.assignments = [withCoords('job-1', 40.711, -73.404)];
    const out = await armZonesForDate('2026-08-28');
    // A geozone is per-device, so two vehicles means two zones over one location.
    expect(out.armed).toBe(2);
    expect(db.inserted).toHaveLength(2);
    expect(db.inserted[0]).toMatchObject({ kind: 'job', job_id: 'job-1', assigned_date: '2026-08-28' });
  });

  it('SKIPS a property with no verified coordinate instead of guessing one', async () => {
    // The phase-1 backfill deliberately refused imprecise geocodes. A geofence
    // around a town centroid would make every van driving through town look like
    // it arrived, which is the exact failure that refusal prevents.
    db.assignments = [withCoords('job-1', null, null)];
    const out = await armZonesForDate('2026-08-28');
    expect(out.armed).toBe(0);
    expect(out.skipped[0]).toMatchObject({ jobId: 'job-1', reason: expect.stringContaining('no verified coordinate') });
    expect(bouncieFetch).not.toHaveBeenCalled();
  });

  it('arms a job ONCE even when several crew are assigned to it', async () => {
    db.assignments = [withCoords('job-1', 40.7, -73.4), withCoords('job-1', 40.7, -73.4)];
    const out = await armZonesForDate('2026-08-28');
    expect(out.armed).toBe(1);
  });

  it('is idempotent: an already-armed job is skipped, not double-registered', async () => {
    db.assignments = [withCoords('job-1', 40.7, -73.4)];
    db.existingZones = [{ id: 'already' }];
    const out = await armZonesForDate('2026-08-28');
    expect(out.armed).toBe(0);
    expect(out.skipped[0]!.reason).toBe('already armed');
  });

  it('records a failure per job instead of aborting the whole day', async () => {
    db.assignments = [withCoords('job-1', 40.7, -73.4)];
    bouncieFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    const out = await armZonesForDate('2026-08-28');
    expect(out.failed).toHaveLength(1);
    expect(out.armed).toBe(0);
  });

  it('does nothing when there are no active vehicles', async () => {
    db.vehicles = [];
    db.assignments = [withCoords('job-1', 40.7, -73.4)];
    expect(await armZonesForDate('2026-08-28')).toMatchObject({ armed: 0 });
    expect(bouncieFetch).not.toHaveBeenCalled();
  });
});

describe('retireZonesBefore', () => {
  it('retires locally even when the remote delete fails', async () => {
    // A zone we cannot delete is still one we should stop attributing visits to,
    // and leaving it live would block re-arming the same job later.
    db.staleZones = [{ id: 'row-1', bouncie_geozone_id: 'z', bouncie_location_id: 'l' }];
    bouncieFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await retireZonesBefore('2026-08-28');
    expect(out).toEqual({ retired: 1, failed: 1 });
    expect(db.updated[0]).toHaveProperty('retired_at');
  });

  it('retires cleanly when the remote delete works', async () => {
    db.staleZones = [{ id: 'row-1', bouncie_geozone_id: 'z', bouncie_location_id: 'l' }];
    const out = await retireZonesBefore('2026-08-28');
    expect(out).toEqual({ retired: 1, failed: 0 });
  });
});
