// #167 P1 slice 2 — archive imagery worker.
//
// The behaviours that actually matter here are the ones that protect the
// TRAINING CORPUS, so they get the most coverage: an imprecise geocode must
// never produce a stored satellite (that would file a stranger's roof as this
// address's ground truth), and a failed property must record why instead of
// looping forever.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  isSupabaseServiceConfigured: () => !!sbRef.current,
}));

const { maps } = vi.hoisted(() => ({
  maps: {
    isGoogleMapsConfigured: vi.fn(() => true),
    geocodeAddress: vi.fn(),
    fetchSatellite: vi.fn(),
    fetchStreetView: vi.fn(),
    resolveStreetViewPano: vi.fn(),
  },
}));
vi.mock('./googleMaps', () => maps);

import {
  fetchArchiveImageryBatch,
  getArchiveImageryStatus,
  archiveStoragePrefix,
  satelliteFeetPerPixel,
  pngDimensions,
  safeErrorMessage,
} from './archiveImagery';

// ─── helpers ────────────────────────────────────────────────────────────────

/** Minimal valid PNG: 8-byte signature + IHDR length/type/width/height. */
function pngBuffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

type FakeRow = {
  id: string;
  resolved_address: string | null;
  resolved_address_key: string | null;
  status: string;
  satellite_ref: string | null;
  imagery_error: string | null;
};

type Filter = { col: string; op: 'eq' | 'isNull' | 'notNull' };
type Update = { patch: Record<string, unknown>; ids: string[]; status?: string };

function matches(row: Record<string, unknown>, filters: Array<Filter & { value?: unknown }>): boolean {
  return filters.every((f) => {
    if (f.op === 'eq') return row[f.col] === f.value;
    if (f.op === 'isNull') return row[f.col] === null || row[f.col] === undefined;
    return row[f.col] !== null && row[f.col] !== undefined;
  });
}

function makeSb(rows: FakeRow[]) {
  const uploads: Array<{ path: string; bytes: number; contentType?: string }> = [];
  const updates: Update[] = [];
  let uploadError: string | null = null;

  const client = {
    from() {
      return {
        select(cols: string) {
          const filters: Array<Filter & { value?: unknown }> = [];
          const wanted = cols.split(',').map((c) => c.trim());
          const builder = {
            eq(col: string, value: unknown) {
              filters.push({ col, op: 'eq', value });
              return builder;
            },
            is(col: string, value: unknown) {
              filters.push({ col, op: value === null ? 'isNull' : 'eq', value });
              return builder;
            },
            not(col: string, _op: string, _value: unknown) {
              filters.push({ col, op: 'notNull' });
              return builder;
            },
            then(resolve: (r: { data: unknown; error: null }) => void) {
              const hit = rows
                .filter((r) => matches(r as unknown as Record<string, unknown>, filters))
                .map((r) => Object.fromEntries(wanted.map((c) => [c, (r as unknown as Record<string, unknown>)[c]])));
              resolve({ data: hit, error: null });
            },
          };
          return builder;
        },
        update(patch: Record<string, unknown>) {
          const captured: Update = { patch, ids: [] };
          const builder = {
            in(_col: string, ids: string[]) {
              captured.ids = ids;
              return builder;
            },
            eq(col: string, value: unknown) {
              if (col === 'status') captured.status = value as string;
              return builder;
            },
            then(resolve: (r: { error: null }) => void) {
              updates.push(captured);
              // Reflect the write so a later status read in the same test sees it.
              for (const row of rows) {
                if (!captured.ids.includes(row.id)) continue;
                if (captured.status !== undefined && row.status !== captured.status) continue;
                Object.assign(row, captured.patch);
              }
              resolve({ error: null });
            },
          };
          return builder;
        },
      };
    },
    storage: {
      from() {
        return {
          async upload(path: string, buf: Buffer, opts?: { contentType?: string }) {
            if (uploadError) return { error: { message: uploadError } };
            uploads.push({ path, bytes: buf.length, contentType: opts?.contentType });
            return { error: null };
          },
        };
      },
    },
  };

  return {
    client,
    uploads,
    updates,
    failUploads(message: string) {
      uploadError = message;
    },
  };
}

function row(over: Partial<FakeRow> & { id: string }): FakeRow {
  return {
    resolved_address: '12 Elm St, Massapequa NY 11758',
    resolved_address_key: '12 elm st massapequa ny 11758',
    status: 'pending',
    satellite_ref: null,
    imagery_error: null,
    ...over,
  };
}

const PRECISE = {
  lat: 40.68,
  lng: -73.47,
  formattedAddress: '12 Elm St, Massapequa, NY 11758, USA',
  locationType: 'ROOFTOP',
  partialMatch: false,
  hasStreetAddress: true,
};

function armHappyPath() {
  maps.geocodeAddress.mockResolvedValue(PRECISE);
  maps.fetchSatellite.mockResolvedValue({ base64: pngBuffer(640, 640).toString('base64'), mediaType: 'image/png' });
  maps.resolveStreetViewPano.mockResolvedValue({ status: 'OK', panoId: 'p1', lat: 40.68, lng: -73.47 });
  maps.fetchStreetView.mockResolvedValue({ base64: Buffer.from('jpegbytes').toString('base64'), mediaType: 'image/jpeg' });
}

beforeEach(() => {
  vi.clearAllMocks();
  maps.isGoogleMapsConfigured.mockReturnValue(true);
});

// ─── pure helpers ───────────────────────────────────────────────────────────

describe('pngDimensions', () => {
  it('reads width/height out of the IHDR chunk', () => {
    expect(pngDimensions(pngBuffer(640, 640))).toEqual({ width: 640, height: 640 });
    expect(pngDimensions(pngBuffer(1024, 512))).toEqual({ width: 1024, height: 512 });
  });

  it('returns null for a non-PNG body, a truncated buffer, or a zero dimension', () => {
    expect(pngDimensions(Buffer.from('<html>not a map</html>'))).toBeNull();
    expect(pngDimensions(pngBuffer(640, 640).subarray(0, 20))).toBeNull();
    expect(pngDimensions(pngBuffer(0, 640))).toBeNull();
    // Right signature, wrong first chunk.
    const wrongChunk = pngBuffer(640, 640);
    wrongChunk.write('IDAT', 12, 'ascii');
    expect(pngDimensions(wrongChunk)).toBeNull();
  });
});

describe('archiveStoragePrefix', () => {
  it('produces a safe, stable, collision-resistant object prefix', () => {
    const a = archiveStoragePrefix('12 elm st massapequa ny 11758');
    expect(a).toBe(archiveStoragePrefix('12 elm st massapequa ny 11758'));
    expect(a).toMatch(/^[a-z0-9-]+$/);
    expect(a).not.toContain('/');
    expect(a).not.toContain('..');
    expect(a).not.toBe(archiveStoragePrefix('13 elm st massapequa ny 11758'));
  });

  it('keeps two long addresses distinct even when their slugs truncate identically', () => {
    const base = 'a'.repeat(70);
    expect(archiveStoragePrefix(`${base} one`)).not.toBe(archiveStoragePrefix(`${base} two`));
  });
});

describe('satelliteFeetPerPixel', () => {
  it('matches the Static Maps ground resolution at zoom 20 on Long Island', () => {
    // 156543.03392 * cos(40.68°) / 2^20 m/px * 3.28084 ft/m
    expect(satelliteFeetPerPixel(40.68)).toBeCloseTo(0.3717, 3);
  });

  it('shrinks with latitude and with zoom', () => {
    expect(satelliteFeetPerPixel(60)).toBeLessThan(satelliteFeetPerPixel(40));
    expect(satelliteFeetPerPixel(40, 21)).toBeCloseTo(satelliteFeetPerPixel(40, 20) / 2, 6);
  });
});

describe('safeErrorMessage', () => {
  it('never lets a Google API key through and bounds the length', () => {
    const msg = safeErrorMessage(new Error('fetch failed: https://maps.googleapis.com/x?a=1&key=AIzaSuperSecret&b=2'));
    expect(msg).not.toContain('AIzaSuperSecret');
    expect(msg).toContain('key=***');
    expect(safeErrorMessage(new Error('x'.repeat(500)))).toHaveLength(300);
  });
});

// ─── the batch ──────────────────────────────────────────────────────────────

describe('fetchArchiveImageryBatch', () => {
  it('fetches once per PROPERTY and stamps every one of its photo rows', async () => {
    armHappyPath();
    const sb = makeSb([row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]);
    sbRef.current = sb.client;

    const run = await fetchArchiveImageryBatch();

    // Three photos, ONE house: one geocode, one satellite, one Street View.
    expect(maps.geocodeAddress).toHaveBeenCalledTimes(1);
    expect(maps.fetchSatellite).toHaveBeenCalledTimes(1);
    expect(maps.fetchStreetView).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({ attempted: 1, fetched: 1, failed: 0, remaining: 0 });
    expect(run.results[0]).toMatchObject({ ok: true, photos: 3 });

    const prefix = archiveStoragePrefix('12 elm st massapequa ny 11758');
    expect(sb.uploads).toEqual([
      { path: `${prefix}/satellite.png`, bytes: 24, contentType: 'image/png' },
      { path: `${prefix}/street-view.jpg`, bytes: 9, contentType: 'image/jpeg' },
    ]);

    expect(sb.updates).toHaveLength(1);
    expect(sb.updates[0].ids.sort()).toEqual(['a', 'b', 'c']);
    expect(sb.updates[0].status).toBe('pending'); // guarded write
    expect(sb.updates[0].patch).toMatchObject({
      satellite_ref: `${prefix}/satellite.png`,
      street_view_ref: `${prefix}/street-view.jpg`,
      satellite_w: 640,
      satellite_h: 640,
      imagery_error: null,
      status: 'ready_to_trace',
    });
    expect(sb.updates[0].patch.satellite_feet_per_pixel).toBeCloseTo(0.3717, 3);
  });

  it('pins zoom and size explicitly so the stored scale can never drift from the image', async () => {
    armHappyPath();
    sbRef.current = makeSb([row({ id: 'a' })]).client;

    await fetchArchiveImageryBatch();

    expect(maps.fetchSatellite).toHaveBeenCalledWith(PRECISE.lat, PRECISE.lng, { size: '640x640', zoom: 20 });
  });

  // THE corpus guard.
  it('refuses to store imagery for an imprecise geocode and records why', async () => {
    maps.geocodeAddress.mockResolvedValue({
      lat: 40.68,
      lng: -73.47,
      formattedAddress: 'Amityville, NY, USA',
      locationType: 'APPROXIMATE',
      partialMatch: true,
      hasStreetAddress: false,
    });
    const sb = makeSb([row({ id: 'a' }), row({ id: 'b' })]);
    sbRef.current = sb.client;

    const run = await fetchArchiveImageryBatch();

    expect(maps.fetchSatellite).not.toHaveBeenCalled();
    expect(maps.fetchStreetView).not.toHaveBeenCalled();
    expect(sb.uploads).toEqual([]);
    expect(run).toMatchObject({ attempted: 1, fetched: 0, failed: 1 });
    expect(run.results[0].error).toMatch(/Imprecise geocode/);
    expect(run.results[0].error).toMatch(/Amityville/);

    expect(sb.updates).toHaveLength(1);
    expect(sb.updates[0].ids.sort()).toEqual(['a', 'b']);
    expect(sb.updates[0].patch.status).toBeUndefined(); // still pending
    expect(String(sb.updates[0].patch.imagery_error)).toMatch(/Imprecise geocode/);
  });

  it('still stores the satellite when the property has no Street View panorama', async () => {
    armHappyPath();
    maps.resolveStreetViewPano.mockResolvedValue({ status: 'ZERO_RESULTS' });
    const sb = makeSb([row({ id: 'a' })]);
    sbRef.current = sb.client;

    const run = await fetchArchiveImageryBatch();

    expect(maps.fetchStreetView).not.toHaveBeenCalled();
    expect(run.results[0]).toMatchObject({ ok: true, streetViewRef: null });
    expect(sb.uploads).toHaveLength(1);
    expect(sb.uploads[0].path).toMatch(/satellite\.png$/);
    expect(sb.updates[0].patch).toMatchObject({ street_view_ref: null, status: 'ready_to_trace' });
  });

  it('treats a non-PNG satellite body as a failure rather than guessing the canvas size', async () => {
    armHappyPath();
    maps.fetchSatellite.mockResolvedValue({
      base64: Buffer.from('<html>quota exceeded</html>').toString('base64'),
      mediaType: 'image/png',
    });
    const sb = makeSb([row({ id: 'a' })]);
    sbRef.current = sb.client;

    const run = await fetchArchiveImageryBatch();

    expect(sb.uploads).toEqual([]);
    expect(run.results[0].ok).toBe(false);
    expect(run.results[0].error).toMatch(/not a PNG/);
  });

  it('records the reason when a fetch throws, so the property is not retried forever', async () => {
    maps.geocodeAddress.mockRejectedValue(new Error('Geocode failed: OVER_QUERY_LIMIT'));
    const sb = makeSb([row({ id: 'a' })]);
    sbRef.current = sb.client;

    const run = await fetchArchiveImageryBatch();

    expect(run).toMatchObject({ attempted: 1, fetched: 0, failed: 1 });
    expect(String(sb.updates[0].patch.imagery_error)).toBe('Geocode failed: OVER_QUERY_LIMIT');

    // Second run skips it — imagery_error is now set.
    vi.clearAllMocks();
    maps.isGoogleMapsConfigured.mockReturnValue(true);
    const second = await fetchArchiveImageryBatch();
    expect(second).toMatchObject({ attempted: 0, remaining: 0 });
    expect(maps.geocodeAddress).not.toHaveBeenCalled();

    // ...unless the operator explicitly retries.
    armHappyPath();
    const retried = await fetchArchiveImageryBatch({ retryFailed: true });
    expect(retried).toMatchObject({ attempted: 1, fetched: 1 });
  });

  it('fails the property (not the run) when the satellite upload errors', async () => {
    armHappyPath();
    const sb = makeSb([row({ id: 'a' }), row({ id: 'b', resolved_address_key: 'other st', resolved_address: 'Other St' })]);
    sb.failUploads('bucket not found');
    sbRef.current = sb.client;

    const run = await fetchArchiveImageryBatch();

    expect(run).toMatchObject({ attempted: 2, fetched: 0, failed: 2 });
    expect(run.results[0].error).toMatch(/satellite upload: bucket not found/);
  });

  it('honours the limit and reports what is left', async () => {
    armHappyPath();
    const sb = makeSb([
      row({ id: 'a', resolved_address_key: 'aaa', resolved_address: 'A St' }),
      row({ id: 'b', resolved_address_key: 'bbb', resolved_address: 'B St' }),
      row({ id: 'c', resolved_address_key: 'ccc', resolved_address: 'C St' }),
    ]);
    sbRef.current = sb.client;

    const run = await fetchArchiveImageryBatch({ limit: 2 });

    expect(run).toMatchObject({ attempted: 2, fetched: 2, remaining: 1 });
    expect(run.results.map((r) => r.addressKey)).toEqual(['aaa', 'bbb']);
  });

  it('never claims a row with no address, an existing satellite, or a non-pending status', async () => {
    armHappyPath();
    const sb = makeSb([
      row({ id: 'no-address', resolved_address: null, resolved_address_key: null }),
      row({ id: 'done', resolved_address_key: 'done st', satellite_ref: 'done-st-1234/satellite.png' }),
      row({ id: 'excluded', resolved_address_key: 'shop st', status: 'excluded' }),
      row({ id: 'work', resolved_address_key: 'work st', resolved_address: 'Work St' }),
    ]);
    sbRef.current = sb.client;

    const run = await fetchArchiveImageryBatch();

    expect(run.results.map((r) => r.addressKey)).toEqual(['work st']);
  });

  it('stops on the deadline instead of being killed mid-property', async () => {
    armHappyPath();
    const sb = makeSb([
      row({ id: 'a', resolved_address_key: 'aaa', resolved_address: 'A St' }),
      row({ id: 'b', resolved_address_key: 'bbb', resolved_address: 'B St' }),
    ]);
    sbRef.current = sb.client;

    const run = await fetchArchiveImageryBatch({ deadlineMs: 0 });

    expect(run).toMatchObject({ attempted: 0, stoppedOnDeadline: true, remaining: 2 });
    expect(maps.geocodeAddress).not.toHaveBeenCalled();
  });

  it('refuses to run without a Google key rather than marking every property failed', async () => {
    maps.isGoogleMapsConfigured.mockReturnValue(false);
    const sb = makeSb([row({ id: 'a' })]);
    sbRef.current = sb.client;

    await expect(fetchArchiveImageryBatch()).rejects.toThrow(/GOOGLE_MAPS_API_KEY/);
    expect(sb.updates).toEqual([]);
  });
});

describe('getArchiveImageryStatus', () => {
  it('counts properties by imagery state and surfaces the rows with no address to geocode', async () => {
    sbRef.current = makeSb([
      // One imaged property, two photos — counts once.
      row({ id: '1', resolved_address_key: 'done st', status: 'ready_to_trace', satellite_ref: 'x/satellite.png' }),
      row({ id: '2', resolved_address_key: 'done st', status: 'ready_to_trace', satellite_ref: 'x/satellite.png' }),
      // One failed property.
      row({ id: '3', resolved_address_key: 'bad st', imagery_error: 'Imprecise geocode' }),
      // Two untouched properties.
      row({ id: '4', resolved_address_key: 'new st' }),
      row({ id: '5', resolved_address_key: 'other st' }),
      // No address to geocode — the needs-identification lane.
      row({ id: '6', resolved_address: null, resolved_address_key: null }),
      // A non-install; never enters the imagery queue.
      row({ id: '7', resolved_address_key: 'shop st', status: 'excluded' }),
    ]).client;

    const status = await getArchiveImageryStatus();

    expect(status.properties).toEqual({ total: 4, withImagery: 1, failed: 1, pending: 2 });
    expect(status.photos).toEqual({ total: 7, pending: 4, readyToTrace: 2, excluded: 1, other: 0 });
    expect(status.needsAddress).toBe(1);
  });
});
