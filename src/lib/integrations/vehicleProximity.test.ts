// The polling proximity engine — the second clock's writer.
//
// What matters most here: read failures surface instead of arming nothing
// silently (the geofence draft's fatal flaw), no-signal never closes a visit,
// the 15-minute rule flags rather than discards, and the writer touches only
// the tables it claims to (constraint (a)).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const { bouncieFetch, db } = vi.hoisted(() => {
  const bouncieFetch = vi.fn(async (_path: string) => ({ ok: true, status: 200, json: async () => [] }) as unknown as Response);
  const db = {
    vehicles: [] as { id: string; imei: string; label: string }[],
    assignments: [] as { job_id: string }[],
    jobs: [] as { id: string; property_id: string | null }[],
    properties: [] as { id: string; lat: number | null; lng: number | null }[],
    openVisits: [] as { id: string; kind: string; job_id: string | null; entered_at: string }[],
    errors: {} as Record<string, { message: string } | undefined>,
    inserted: [] as Record<string, unknown>[],
    updated: [] as { table: string; row: Record<string, unknown> }[],
    touched: [] as string[],
  };
  return { bouncieFetch, db };
});

vi.mock('@/lib/integrations/bouncieAuth', () => ({ bouncieFetch, isBouncieOAuthConfigured: () => true }));
vi.mock('@/lib/supabase', () => ({
  getSupabaseServiceClient: () => ({
    from: (table: string) => {
      db.touched.push(table);
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      Object.assign(chain, {
        select: self, eq: self, is: self, not: self, in: self, limit: self,
        returns: async () => {
          const error = db.errors[table] ?? null;
          if (error) return { data: null, error };
          if (table === 'vehicles') return { data: db.vehicles, error: null };
          if (table === 'job_assignments') return { data: db.assignments, error: null };
          if (table === 'jobs') return { data: db.jobs, error: null };
          if (table === 'properties') return { data: db.properties, error: null };
          if (table === 'vehicle_visits') return { data: db.openVisits, error: null };
          return { data: [], error: null };
        },
        insert: (row: Record<string, unknown>) => {
          db.inserted.push(row);
          return Promise.resolve({ error: null });
        },
        update: (row: Record<string, unknown>) => {
          db.updated.push({ table, row });
          const u: Record<string, unknown> = {};
          const uSelf = () => u;
          Object.assign(u, { eq: uSelf, is: uSelf, then: (res: (v: { error: null }) => unknown) => Promise.resolve({ error: null }).then(res) });
          return u;
        },
      });
      return chain;
    },
  }),
}));

import {
  distanceMetres,
  resolvePlace,
  pollVehiclePositions,
  DEPOT,
  type WatchedPlace,
} from './vehicleProximity';

const NOW = new Date('2026-08-28T15:00:00.000Z'); // 11:00 ET — a working morning
const FRESH = '2026-08-28T14:59:00.000Z'; // one minute before the poll

function bouncieReports(vehicles: Array<{ imei: string; lat?: number; lon?: number; lastUpdated?: string }>) {
  bouncieFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () =>
      vehicles.map((v) => ({
        imei: v.imei,
        stats: {
          lastUpdated: v.lastUpdated ?? FRESH,
          location: v.lat != null ? { lat: v.lat, lon: v.lon } : undefined,
        },
      })),
  } as unknown as Response);
}

beforeEach(() => {
  bouncieFetch.mockClear();
  bouncieReports([]);
  db.vehicles = [{ id: 'veh-1', imei: '865612075879763', label: 'Van' }];
  db.assignments = [];
  db.jobs = [];
  db.properties = [];
  db.openVisits = [];
  db.errors = {};
  db.inserted = [];
  db.updated = [];
  db.touched = [];
});

function scheduleJob(jobId: string, lat: number, lng: number) {
  db.assignments.push({ job_id: jobId });
  db.jobs.push({ id: jobId, property_id: `prop-${jobId}` });
  db.properties.push({ id: `prop-${jobId}`, lat, lng });
}

describe('distanceMetres', () => {
  it('is ~0 for the same point and grows with separation', () => {
    expect(distanceMetres(DEPOT, DEPOT)).toBeLessThan(1);
    // Roughly 111m per 0.001 degrees of latitude.
    const d = distanceMetres({ lat: 40.7, lng: -73.4 }, { lat: 40.701, lng: -73.4 });
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(125);
  });
});

describe('resolvePlace', () => {
  const jobA: WatchedPlace = { kind: 'job', jobId: 'a', lat: 40.7, lng: -73.4 };
  const jobB: WatchedPlace = { kind: 'job', jobId: 'b', lat: 40.701, lng: -73.4 }; // ~111m north

  it('returns null when nothing is within the radius', () => {
    expect(resolvePlace({ lat: 40.9, lng: -73.4 }, [jobA, jobB])).toBeNull();
  });

  it('picks the NEAREST place when overlapping circles both contain the van', () => {
    // Two houses ~111m apart: a van at job A sits inside both circles at 120m.
    // Naldo's rule is that the scheduler's ordering decides; until day-ordering
    // is built, nearest wins — the van is physically closest to the job it is at.
    const atA = { lat: 40.7001, lng: -73.4 };
    expect(resolvePlace(atA, [jobB, jobA])?.jobId).toBe('a');
  });

  it('respects a custom radius', () => {
    expect(resolvePlace({ lat: 40.7005, lng: -73.4 }, [jobA], 10)).toBeNull();
  });
});

describe('pollVehiclePositions', () => {
  it('opens a visit when a fresh position is inside a scheduled job', async () => {
    scheduleJob('job-1', 40.75, -73.5);
    bouncieReports([{ imei: '865612075879763', lat: 40.7501, lon: -73.5 }]);
    const out = await pollVehiclePositions(NOW);
    expect(out.errors).toEqual([]);
    expect(out.opened).toBe(1);
    expect(db.inserted[0]).toMatchObject({ vehicle_id: 'veh-1', kind: 'job', job_id: 'job-1' });
    // The evidence rides with the visit, for tuning the radius later.
    expect(db.inserted[0]).toHaveProperty('entered_lat', 40.7501);
  });

  it('records the depot as a depot visit with no job', async () => {
    bouncieReports([{ imei: '865612075879763', lat: DEPOT.lat, lon: DEPOT.lng }]);
    const out = await pollVehiclePositions(NOW);
    expect(out.opened).toBe(1);
    expect(db.inserted[0]).toMatchObject({ kind: 'depot', job_id: null });
  });

  it('does nothing while the van stays at the same place', async () => {
    scheduleJob('job-1', 40.75, -73.5);
    db.openVisits = [{ id: 'v1', kind: 'job', job_id: 'job-1', entered_at: '2026-08-28T14:00:00.000Z' }];
    bouncieReports([{ imei: '865612075879763', lat: 40.75, lon: -73.5 }]);
    const out = await pollVehiclePositions(NOW);
    expect(out.opened).toBe(0);
    expect(out.closed).toBe(0);
    expect(db.inserted).toHaveLength(0);
  });

  it('closes the visit when the van leaves, marking a real stay as counting', async () => {
    // Entered an hour ago: well past the 15-minute rule.
    scheduleJob('job-1', 40.75, -73.5);
    db.openVisits = [{ id: 'v1', kind: 'job', job_id: 'job-1', entered_at: '2026-08-28T14:00:00.000Z' }];
    bouncieReports([{ imei: '865612075879763', lat: 40.9, lon: -73.5 }]); // far away now
    const out = await pollVehiclePositions(NOW);
    expect(out.closed).toBe(1);
    const close = db.updated.find((u) => u.table === 'vehicle_visits');
    expect(close?.row).toMatchObject({ below_min_dwell: false });
  });

  // NALDO'S 15-MINUTE RULE: flagged, never discarded.
  it('flags a short stay below the dwell threshold instead of deleting it', async () => {
    scheduleJob('job-1', 40.75, -73.5);
    db.openVisits = [{ id: 'v1', kind: 'job', job_id: 'job-1', entered_at: '2026-08-28T14:52:00.000Z' }]; // 8 minutes
    bouncieReports([{ imei: '865612075879763', lat: 40.9, lon: -73.5 }]);
    await pollVehiclePositions(NOW);
    const close = db.updated.find((u) => u.table === 'vehicle_visits');
    expect(close?.row).toMatchObject({ below_min_dwell: true });
  });

  // ROW 403 CONSTRAINT (c): silence is not departure.
  it('does NOT close an open visit when the device goes silent', async () => {
    scheduleJob('job-1', 40.75, -73.5);
    db.openVisits = [{ id: 'v1', kind: 'job', job_id: 'job-1', entered_at: '2026-08-28T14:00:00.000Z' }];
    bouncieReports([{ imei: '865612075879763', lat: 40.75, lon: -73.5, lastUpdated: '2026-08-28T13:00:00.000Z' }]); // 2h stale
    const out = await pollVehiclePositions(NOW);
    expect(out.noSignal).toBe(1);
    expect(out.closed).toBe(0);
    // A van whose device fell silent AT a job has not left the job. Closing on
    // silence would write a departure that never happened.
  });

  it('updates the map columns with BOUNCIE’S timestamp, not the poll time', async () => {
    bouncieReports([{ imei: '865612075879763', lat: 40.8, lon: -73.45, lastUpdated: FRESH }]);
    await pollVehiclePositions(NOW);
    const pos = db.updated.find((u) => u.table === 'vehicles');
    expect(pos?.row).toMatchObject({ last_lat: 40.8, last_lng: -73.45, last_seen_at: FRESH });
  });

  // THE GEOFENCE DRAFT'S FATAL FLAW, never again.
  it('SURFACES a read failure instead of reporting a clean run', async () => {
    scheduleJob('job-1', 40.75, -73.5);
    db.errors.job_assignments = { message: 'boom' };
    bouncieReports([{ imei: '865612075879763', lat: 40.75, lon: -73.5 }]);
    const out = await pollVehiclePositions(NOW);
    expect(out.errors[0]).toMatch(/reading job_assignments/);
  });

  it('surfaces a Bouncie failure', async () => {
    bouncieFetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) } as unknown as Response);
    const out = await pollVehiclePositions(NOW);
    expect(out.errors[0]).toMatch(/returned 401/);
  });

  it('makes exactly ONE Bouncie call per cycle regardless of fleet size', async () => {
    db.vehicles = [
      { id: 'v1', imei: '111111111111111', label: 'Van' },
      { id: 'v2', imei: '222222222222222', label: 'Truck' },
    ];
    bouncieReports([
      { imei: '111111111111111', lat: 40.8, lon: -73.45 },
      { imei: '222222222222222', lat: 40.81, lon: -73.46 },
    ]);
    await pollVehiclePositions(NOW);
    expect(bouncieFetch).toHaveBeenCalledTimes(1);
  });

  // ROW 403 CONSTRAINT (a).
  it('NEVER touches shifts or job_segments', async () => {
    scheduleJob('job-1', 40.75, -73.5);
    bouncieReports([{ imei: '865612075879763', lat: 40.7501, lon: -73.5 }]);
    await pollVehiclePositions(NOW);
    expect(db.touched).not.toContain('shifts');
    expect(db.touched).not.toContain('job_segments');
  });
});
