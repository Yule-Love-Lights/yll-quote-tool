// Bouncie geofence provisioning.
//
// Two things are most worth pinning here. The coordinate order, because a
// lat/lng swap produces a zone that simply never fires with no error anywhere.
// And the READ SHAPES, because the first version of this file mocked Supabase as
// one generic chain, which is exactly why it could not catch that the nested
// embed the code depended on does not exist in the schema.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { bouncieFetch, db } = vi.hoisted(() => {
  const bouncieFetch = vi.fn(
    async (_path: string, _init?: { method?: string; body?: unknown; accountEmail?: string }) =>
      ({ ok: true, status: 200, json: async () => ({ id: 'remote-1' }) }) as unknown as Response,
  );
  const db = {
    vehicles: [] as { id: string; imei: string; label: string }[],
    assignments: [] as { job_id: string }[],
    jobs: [] as { id: string; property_id: string | null }[],
    properties: [] as { id: string; lat: number | null; lng: number | null }[],
    armed: [] as { job_id: string; vehicle_id: string | null }[],
    stale: [] as { id: string; bouncie_geozone_id: string; bouncie_location_id: string }[],
    errors: {} as Record<string, { message: string } | undefined>,
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
        select: self, eq: self, is: self, not: self, in: self, lt: self, order: self, limit: self,
        returns: async () => {
          const error = db.errors[table] ?? null;
          if (error) return { data: null, error };
          if (table === 'vehicles') return { data: db.vehicles, error: null };
          if (table === 'job_assignments') return { data: db.assignments, error: null };
          if (table === 'jobs') return { data: db.jobs, error: null };
          if (table === 'properties') return { data: db.properties, error: null };
          if (table === 'job_geozones') return { data: db.stale.length ? db.stale : db.armed, error: null };
          return { data: [], error: null };
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
  db.jobs = [];
  db.properties = [];
  db.armed = [];
  db.stale = [];
  db.errors = {};
  db.inserted = [];
  db.updated = [];
  db.insertError = null;
});

/** Wire a job through assignments, jobs and properties, the way the real reads go. */
function scheduleJob(jobId: string, lat: number | null, lng: number | null) {
  db.assignments.push({ job_id: jobId });
  db.jobs.push({ id: jobId, property_id: `prop-${jobId}` });
  db.properties.push({ id: `prop-${jobId}`, lat, lng });
}

describe('buildCircle', () => {
  it('emits [longitude, latitude], NOT [lat, lng]', () => {
    const c = buildCircle(40.711038, -73.403885);
    expect(c.geometry.coordinates).toEqual([-73.403885, 40.711038]);
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

  // THE SWAP THE OLD GUARD COULD NOT CATCH (S68 technical lens, HIGH).
  it('CATCHES a real Long Island lat/lng swap', () => {
    // 40.7 and -73.4 are both legal latitudes and longitudes, so a plain
    // range check passed the swap and produced a zone in the South Atlantic
    // that never fired. Only a service-area bound catches it.
    expect(() => buildCircle(40.711038, -73.403885)).not.toThrow();
    expect(() => buildCircle(-73.403885, 40.711038)).toThrow(/lat\/lng swap/);
  });

  it('rejects a coordinate outside the service area', () => {
    expect(() => buildCircle(34.05, -118.24)).toThrow(BouncieGeozoneError); // Los Angeles
    expect(() => buildCircle(41.88, -87.63)).toThrow(BouncieGeozoneError); // Chicago
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

describe('createLocation and createGeozone', () => {
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

  it('accepts an id nested under location or geozone as well as at the top level', async () => {
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
  it('arms one zone per vehicle for a job with a verified coordinate', async () => {
    db.vehicles = [
      { id: 'v1', imei: '111111111111111', label: 'Van' },
      { id: 'v2', imei: '222222222222222', label: 'Truck' },
    ];
    scheduleJob('job-1', 40.711, -73.404);
    const out = await armZonesForDate('2026-08-28');
    expect(out.armed).toBe(2);
    expect(out.errors).toEqual([]);
    expect(db.inserted[0]).toMatchObject({ kind: 'job', job_id: 'job-1', assigned_date: '2026-08-28', vehicle_id: 'v1' });
    expect(db.inserted[1]).toMatchObject({ vehicle_id: 'v2' });
  });

  // THE DEFECT THAT WOULD HAVE ARMED NOTHING (S68 technical lens, HIGH).
  it('SURFACES a read failure instead of reporting a clean run that armed nothing', async () => {
    // The first version dropped `error` from every read. jobs.property_id has no
    // FK to properties, so the nested embed it used returned PGRST200 and the
    // whole feature silently did nothing, with nothing to see.
    scheduleJob('job-1', 40.711, -73.404);
    db.errors.jobs = { message: 'PGRST200 Could not find a relationship' };
    const out = await armZonesForDate('2026-08-28');
    expect(out.armed).toBe(0);
    expect(out.errors[0]).toMatch(/reading jobs/);
    expect(bouncieFetch).not.toHaveBeenCalled();
  });

  it('surfaces a failure reading vehicles, assignments or properties too', async () => {
    for (const table of ['vehicles', 'job_assignments', 'properties']) {
      db.errors = {};
      db.assignments = [];
      db.jobs = [];
      db.properties = [];
      scheduleJob('job-1', 40.7, -73.4);
      db.errors[table] = { message: 'boom' };
      const out = await armZonesForDate('2026-08-28');
      expect(out.errors.length, table).toBeGreaterThan(0);
    }
  });

  it('SKIPS a property with no verified coordinate instead of guessing one', async () => {
    scheduleJob('job-1', null, null);
    const out = await armZonesForDate('2026-08-28');
    expect(out.armed).toBe(0);
    expect(out.skipped[0]).toMatchObject({ reason: expect.stringContaining('no verified coordinate') });
    expect(bouncieFetch).not.toHaveBeenCalled();
  });

  it('arms a job ONCE even when several crew are assigned to it', async () => {
    scheduleJob('job-1', 40.7, -73.4);
    db.assignments.push({ job_id: 'job-1' });
    expect((await armZonesForDate('2026-08-28')).armed).toBe(1);
  });

  // PER-VEHICLE IDEMPOTENCY (S68 technical and admin lenses, HIGH).
  it('arms the SECOND vehicle when only the first was armed before', async () => {
    // Checking "is this job armed" marked it done forever, leaving the second van
    // permanently unwatched at that job, which reads downstream as a crew that
    // never showed up.
    db.vehicles = [
      { id: 'v1', imei: '111111111111111', label: 'Van' },
      { id: 'v2', imei: '222222222222222', label: 'Truck' },
    ];
    scheduleJob('job-1', 40.7, -73.4);
    db.armed = [{ job_id: 'job-1', vehicle_id: 'v1' }];
    const out = await armZonesForDate('2026-08-28');
    expect(out.armed).toBe(1);
    expect(db.inserted[0]).toMatchObject({ vehicle_id: 'v2' });
  });

  it('skips only when every vehicle is already armed', async () => {
    scheduleJob('job-1', 40.7, -73.4);
    db.armed = [{ job_id: 'job-1', vehicle_id: 'veh-1' }];
    const out = await armZonesForDate('2026-08-28');
    expect(out.armed).toBe(0);
    expect(out.skipped[0]!.reason).toBe('already armed for every vehicle');
  });

  it('names an ORPHANED remote geozone when the local record fails', async () => {
    // The remote zone exists but nothing will ever retire it. That needs a human,
    // not a silent counter.
    scheduleJob('job-1', 40.7, -73.4);
    db.insertError = { message: 'db down' };
    const out = await armZonesForDate('2026-08-28');
    expect(out.armed).toBe(0);
    expect(out.failed[0]!.reason).toMatch(/ORPHANED remote geozone/);
  });

  it('records a failure per job instead of aborting the whole day', async () => {
    scheduleJob('job-1', 40.7, -73.4);
    bouncieFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    const out = await armZonesForDate('2026-08-28');
    expect(out.failed).toHaveLength(1);
    expect(out.armed).toBe(0);
  });

  it('reports it as an error, not silence, when no vehicle is registered', async () => {
    db.vehicles = [];
    scheduleJob('job-1', 40.7, -73.4);
    const out = await armZonesForDate('2026-08-28');
    expect(out.errors[0]).toMatch(/no active vehicle/);
    expect(bouncieFetch).not.toHaveBeenCalled();
  });
});

describe('retireZonesBefore', () => {
  it('retires locally even when the remote delete fails', async () => {
    // A zone we cannot delete is still one we should stop attributing visits to,
    // and leaving it live would block re-arming the same job later.
    db.stale = [{ id: 'row-1', bouncie_geozone_id: 'z', bouncie_location_id: 'l' }];
    bouncieFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as unknown as Response);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await retireZonesBefore('2026-08-28');
    expect(out).toEqual({ retired: 1, failed: 1 });
    expect(db.updated[0]).toHaveProperty('retired_at');
  });

  it('retires cleanly when the remote delete works', async () => {
    db.stale = [{ id: 'row-1', bouncie_geozone_id: 'z', bouncie_location_id: 'l' }];
    const out = await retireZonesBefore('2026-08-28');
    expect(out).toEqual({ retired: 1, failed: 0 });
  });
});
