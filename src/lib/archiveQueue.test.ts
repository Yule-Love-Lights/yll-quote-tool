// #167 P1 slice 3 — the trace queue.
//
// The behaviours worth pinning are the ones that decide whether a human sees
// the right work: a house's many angles must collapse into ONE card (or the
// "80 properties" queue reads as 159 jobs), addressless rows must land in the
// identification lane instead of silently vanishing, and identify must only
// ever fill a BLANK address.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('./supabase', () => ({
  getSupabaseServiceClient: () => sbRef.current,
  isSupabaseServiceConfigured: () => !!sbRef.current,
}));

import { getArchiveQueue, identifyArchivePhoto, excludeArchivePhoto, getArchivePrefill, promoteArchiveProperty } from './archiveQueue';

type Row = Record<string, unknown>;

/**
 * Fake Supabase covering exactly the two shapes this module uses:
 * a filtered SELECT of archive_photos, and a guarded UPDATE.
 */
function makeSb(rows: Row[]) {
  const updates: Array<{ patch: Row; filters: Array<[string, unknown]> }> = [];

  const client = {
    from: () => {
      const filters: Array<[string, unknown]> = [];
      let patch: Row | null = null;
      let isUpdate = false;

      const builder: Record<string, unknown> = {
        select: () => builder,
        order: () => builder,
        neq: (col: string, val: unknown) => { filters.push([`neq:${col}`, val]); return builder; },
        eq: (col: string, val: unknown) => { filters.push([`eq:${col}`, val]); return builder; },
        is: (col: string, val: unknown) => { filters.push([`is:${col}`, val]); return builder; },
        update: (p: Row) => { isUpdate = true; patch = p; return builder; },
        then: (resolve: (v: unknown) => void) => {
          if (isUpdate) {
            updates.push({ patch: patch!, filters });
            // Honour the `.is('resolved_address', null)` guard so the
            // already-identified case is exercised rather than assumed.
            const wantsNullAddress = filters.some(([f]) => f === 'is:resolved_address');
            const targetId = filters.find(([f]) => f === 'eq:id')?.[1];
            const matched = rows.filter(r =>
              r.id === targetId && (!wantsNullAddress || r.resolved_address == null));
            return resolve({ data: matched.map(r => ({ id: r.id })), error: null });
          }
          const visible = rows.filter(r => r.status !== 'excluded');
          return resolve({ data: visible, error: null });
        },
      };
      return builder;
    },
    storage: {
      from: () => ({
        createSignedUrls: async (paths: string[]) => ({
          data: paths.map(p => ({ path: p, signedUrl: `signed:${p}` })),
          error: null,
        }),
        download: async () => ({
          data: { arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer },
          error: null,
        }),
      }),
    },
  };

  return { client, updates };
}

function row(over: Row = {}): Row {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    original_title: 'IMG_0001.jpg',
    resolved_address: '6 Birch Road, Selden',
    resolved_address_key: '6 birch road selden',
    resolved_name: null,
    reviewer_notes: null,
    night_photo_ref: null,
    satellite_ref: null,
    street_view_ref: null,
    satellite_feet_per_pixel: null,
    satellite_w: null,
    satellite_h: null,
    promoted_training_house_id: null,
    status: 'ready_to_trace',
    ...over,
  };
}

beforeEach(() => { sbRef.current = null; });

describe('getArchiveQueue', () => {
  it('returns an empty queue when Supabase is unconfigured', async () => {
    expect(await getArchiveQueue()).toEqual({ properties: [], needsIdentification: [], remaining: 0 });
  });

  it('collapses a house\'s multiple angles into one property card', async () => {
    const { client } = makeSb([
      row({ id: 'a1111111-1111-1111-1111-111111111111', original_title: 'front.jpg' }),
      row({ id: 'b1111111-1111-1111-1111-111111111111', original_title: 'side.jpg' }),
      row({ id: 'c1111111-1111-1111-1111-111111111111', original_title: 'back.jpg' }),
    ]);
    sbRef.current = client;

    const queue = await getArchiveQueue();

    expect(queue.properties).toHaveLength(1);
    expect(queue.properties[0].photoCount).toBe(3);
    expect(queue.properties[0].photos.map(p => p.title)).toEqual(['front.jpg', 'side.jpg', 'back.jpg']);
    expect(queue.remaining).toBe(1);
  });

  it('reads imagery from whichever row in the group carries it', async () => {
    // Slice 2 attaches imagery to the rows it claimed, which is not necessarily
    // the first row of the group — taking group[0] blindly would show a card
    // with no satellite even though the property was fetched.
    const { client } = makeSb([
      row({ id: 'a1111111-1111-1111-1111-111111111111', original_title: 'a.jpg' }),
      row({
        id: 'b1111111-1111-1111-1111-111111111111',
        original_title: 'b.jpg',
        satellite_ref: 'prop/satellite.png',
        satellite_feet_per_pixel: 0.15,
        satellite_w: 640,
        satellite_h: 640,
      }),
    ]);
    sbRef.current = client;

    const [prop] = (await getArchiveQueue()).properties;

    expect(prop.satelliteUrl).toBe('signed:prop/satellite.png');
    expect(prop.satelliteFeetPerPixel).toBe(0.15);
    expect(prop.satelliteW).toBe(640);
  });

  it('routes addressless rows to the identification lane, not the property list', async () => {
    const { client } = makeSb([
      row({ id: 'a1111111-1111-1111-1111-111111111111' }),
      row({
        id: 'd1111111-1111-1111-1111-111111111111',
        original_title: 'IMG_0901.HEIC',
        resolved_address: null,
        resolved_address_key: '',
        resolved_name: 'tal',
        night_photo_ref: 'night/xyz.jpg',
        status: 'pending',
      }),
    ]);
    sbRef.current = client;

    const queue = await getArchiveQueue();

    expect(queue.properties).toHaveLength(1);
    expect(queue.needsIdentification).toHaveLength(1);
    expect(queue.needsIdentification[0].resolvedName).toBe('tal');
    expect(queue.needsIdentification[0].nightPhotoUrl).toBe('signed:night/xyz.jpg');
  });

  it('omits excluded rows and does not count promoted properties as remaining', async () => {
    const { client } = makeSb([
      row({ id: 'a1111111-1111-1111-1111-111111111111' }),
      row({
        id: 'b1111111-1111-1111-1111-111111111111',
        resolved_address: '9 High Ridge Lane',
        resolved_address_key: '9 high ridge lane',
        promoted_training_house_id: 'e1111111-1111-1111-1111-111111111111',
      }),
      row({ id: 'c1111111-1111-1111-1111-111111111111', original_title: 'video.MP4', status: 'excluded' }),
    ]);
    sbRef.current = client;

    const queue = await getArchiveQueue();

    expect(queue.properties).toHaveLength(2);
    expect(queue.remaining).toBe(1);
    // Untraced work sorts above finished houses.
    expect(queue.properties[0].promotedTrainingHouseId).toBeNull();
  });
});

describe('identifyArchivePhoto', () => {
  const ID = 'd1111111-1111-1111-1111-111111111111';

  it('fills a blank address and makes the row claimable again', async () => {
    const { client, updates } = makeSb([row({ id: ID, resolved_address: null })]);
    sbRef.current = client;

    expect(await identifyArchivePhoto(ID, '  701 Bedford Avenue, Bellmore  ')).toEqual({ ok: true });
    expect(updates[0].patch.resolved_address).toBe('701 Bedford Avenue, Bellmore');
    // Back to 'pending' so slice 2's imagery worker picks it up on the next run.
    expect(updates[0].patch.status).toBe('pending');
  });

  it('refuses a row that already has an address', async () => {
    const { client } = makeSb([row({ id: ID, resolved_address: '6 Birch Road, Selden' })]);
    sbRef.current = client;

    const res = await identifyArchivePhoto(ID, '701 Bedford Avenue');

    expect(res).toEqual({ ok: false, error: 'That photo already has an address' });
  });

  it('rejects a blank address without touching the row', async () => {
    const { client, updates } = makeSb([row({ id: ID, resolved_address: null })]);
    sbRef.current = client;

    expect(await identifyArchivePhoto(ID, '   ')).toEqual({ ok: false, error: 'An address is required' });
    expect(updates).toHaveLength(0);
  });
});

describe('getArchivePrefill', () => {
  // THE money-critical line of slice 3. Traced coordinates are normalized to
  // image WIDTH, so the tracer calibrates in feet-per-normalized-unit while the
  // satellite is measured in feet-per-PIXEL. Hand it feetPerPixel raw and every
  // archive example's footage is silently wrong by a factor of the pixel width
  // (here, 640x) — tsc can't catch it and the UI looks fine.
  it('converts feet-per-pixel to feet-per-normalized-width', async () => {
    const { client } = makeSb([
      row({
        satellite_ref: 'prop/satellite.png',
        satellite_feet_per_pixel: 0.25,
        satellite_w: 640,
        satellite_h: 640,
      }),
    ]);
    sbRef.current = client;

    const prefill = await getArchivePrefill('6 birch road selden');

    expect(prefill!.feetPerUnit).toBeCloseTo(160, 6); // 0.25 ft/px * 640 px
    expect(prefill!.satellite.base64).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect(prefill!.address).toBe('6 Birch Road, Selden');
  });

  it('returns null when the property has no satellite to trace on', async () => {
    const { client } = makeSb([row({ satellite_ref: null })]);
    sbRef.current = client;

    expect(await getArchivePrefill('6 birch road selden')).toBeNull();
  });

  // A satellite path with no scale recorded would seed a canvas the operator
  // could draw on while every derived footage silently stayed zero.
  it('returns null when the scale is missing', async () => {
    const { client } = makeSb([
      row({ satellite_ref: 'prop/satellite.png', satellite_feet_per_pixel: null, satellite_w: 640 }),
    ]);
    sbRef.current = client;

    expect(await getArchivePrefill('6 birch road selden')).toBeNull();
  });

  it('passes the night photos through as signed reference URLs', async () => {
    const { client } = makeSb([
      row({
        satellite_ref: 'prop/satellite.png',
        satellite_feet_per_pixel: 0.2,
        satellite_w: 640,
        night_photo_ref: 'night/abc.jpg',
      }),
    ]);
    sbRef.current = client;

    expect((await getArchivePrefill('6 birch road selden'))!.nightPhotoUrls).toEqual(['signed:night/abc.jpg']);
  });
});

describe('promoteArchiveProperty', () => {
  it('links every photo of the property to the saved training house', async () => {
    const { client, updates } = makeSb([row()]);
    sbRef.current = client;

    await promoteArchiveProperty('6 birch road selden', 'e1111111-1111-1111-1111-111111111111');

    expect(updates[0].patch.promoted_training_house_id).toBe('e1111111-1111-1111-1111-111111111111');
    expect(updates[0].patch.status).toBe('approved');
    // Scoped to the property, and never resurrects a row already ruled out.
    expect(updates[0].filters).toContainEqual(['eq:resolved_address_key', '6 birch road selden']);
    expect(updates[0].filters).toContainEqual(['neq:status', 'excluded']);
  });
});

describe('excludeArchivePhoto', () => {
  it('marks the row excluded and records the note', async () => {
    const ID = 'a1111111-1111-1111-1111-111111111111';
    const { client, updates } = makeSb([row({ id: ID })]);
    sbRef.current = client;

    expect(await excludeArchivePhoto(ID, ' not an install ')).toEqual({ ok: true });
    expect(updates[0].patch.status).toBe('excluded');
    expect(updates[0].patch.reviewer_notes).toBe('not an install');
  });
});
