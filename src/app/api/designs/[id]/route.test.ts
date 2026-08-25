// #110 W6-011: GET/PUT /api/designs/[id] (the editor's continuously-called
// autosave endpoint — updateDesignSceneGuarded / linkDesignToQuote /
// updateDesignSatelliteLines) had zero route-level test coverage, unlike its
// sibling design sub-routes. requireOperator, Supabase config, and lib/designs
// mocked. (updateDesignScene became updateDesignSceneGuarded — ledger row 260.)

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const {
  getDesignWithPhoto,
  updateDesignSceneGuarded,
  linkDesignToQuote,
  updateDesignSatelliteLines,
  updateDesignPortalVisibility,
  requireOperatorMock,
  isConfigured,
} = vi.hoisted(() => ({
  getDesignWithPhoto: vi.fn(),
  updateDesignSceneGuarded: vi.fn(),
  linkDesignToQuote: vi.fn(),
  updateDesignSatelliteLines: vi.fn(),
  updateDesignPortalVisibility: vi.fn(),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  isConfigured: { current: true },
}));

vi.mock('@/lib/designs', () => ({
  getDesignWithPhoto,
  updateDesignSceneGuarded,
  linkDesignToQuote,
  updateDesignSatelliteLines,
  updateDesignPortalVisibility,
  isValidDesignId: (id: unknown) =>
    typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => isConfigured.current,
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
}));

import { GET, PUT } from './route';

const VALID_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const ctx = (id = VALID_ID) => ({ params: Promise.resolve({ id }) });
const getReq = {} as NextRequest;

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const validScene = { items: [], yardsticks: [] };
const validSatelliteLines = { santas: [], gingerbread: [], c9: [] };

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  isConfigured.current = true;
  getDesignWithPhoto.mockResolvedValue({ id: VALID_ID, scene: validScene, version: 1 });
  updateDesignSceneGuarded.mockResolvedValue({ ok: true, version: 2 });
  linkDesignToQuote.mockResolvedValue(true);
  updateDesignSatelliteLines.mockResolvedValue(true);
  updateDesignPortalVisibility.mockResolvedValue({
    portalShowStreetView: true,
    portalShowSatelliteView: true,
  });
});

describe('GET /api/designs/[id]', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await GET(getReq, ctx());
    expect(res.status).toBe(401);
    expect(getDesignWithPhoto).not.toHaveBeenCalled();
  });

  it('503s when Supabase service role is not configured', async () => {
    isConfigured.current = false;
    const res = await GET(getReq, ctx());
    expect(res.status).toBe(503);
  });

  it('400s an invalid id', async () => {
    const res = await GET(getReq, ctx('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(getDesignWithPhoto).not.toHaveBeenCalled();
  });

  it('404s when the design does not exist', async () => {
    getDesignWithPhoto.mockResolvedValueOnce(null);
    const res = await GET(getReq, ctx());
    expect(res.status).toBe(404);
  });

  it('returns the design on success', async () => {
    const res = await GET(getReq, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.design.id).toBe(VALID_ID);
  });
});

describe('PUT /api/designs/[id]', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await PUT(makeReq({ scene: validScene }), ctx());
    expect(res.status).toBe(401);
    expect(updateDesignSceneGuarded).not.toHaveBeenCalled();
    expect(updateDesignPortalVisibility).not.toHaveBeenCalled();
  });

  it('503s when Supabase service role is not configured', async () => {
    isConfigured.current = false;
    const res = await PUT(makeReq({ scene: validScene }), ctx());
    expect(res.status).toBe(503);
    expect(updateDesignPortalVisibility).not.toHaveBeenCalled();
  });

  it('400s an invalid id', async () => {
    const res = await PUT(makeReq({ scene: validScene }), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(updateDesignPortalVisibility).not.toHaveBeenCalled();
  });

  it('400s invalid JSON', async () => {
    const req = { json: async () => { throw new Error('bad'); } } as unknown as NextRequest;
    const res = await PUT(req, ctx());
    expect(res.status).toBe(400);
  });

  it('400s when no supported update field is provided', async () => {
    const res = await PUT(makeReq({}), ctx());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/nothing to update/i);
  });

  it.each(['false', null, undefined])('400s a present non-boolean portal visibility value (%s)', async (value) => {
    const res = await PUT(makeReq({ portalShowStreetView: value }), ctx());
    expect(res.status).toBe(400);
    expect(updateDesignPortalVisibility).not.toHaveBeenCalled();
  });

  it('validates portal visibility before saving any other field', async () => {
    const res = await PUT(
      makeReq({ scene: validScene, portalShowSatelliteView: 'false' }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(updateDesignPortalVisibility).not.toHaveBeenCalled();
  });

  it('updates only the submitted portal visibility flag and returns canonical state', async () => {
    updateDesignPortalVisibility.mockResolvedValueOnce({
      portalShowStreetView: false,
      portalShowSatelliteView: true,
    });

    const res = await PUT(makeReq({ portalShowStreetView: false }), ctx());

    expect(res.status).toBe(200);
    expect(updateDesignPortalVisibility).toHaveBeenCalledTimes(1);
    expect(updateDesignPortalVisibility).toHaveBeenCalledWith(VALID_ID, {
      portalShowStreetView: false,
    });
    expect(await res.json()).toEqual({
      ok: true,
      portalShowStreetView: false,
      portalShowSatelliteView: true,
    });
  });

  it('updates both portal visibility flags atomically through one helper call', async () => {
    updateDesignPortalVisibility.mockResolvedValueOnce({
      portalShowStreetView: false,
      portalShowSatelliteView: false,
    });

    const res = await PUT(
      makeReq({ portalShowStreetView: false, portalShowSatelliteView: false }),
      ctx(),
    );

    expect(res.status).toBe(200);
    expect(updateDesignPortalVisibility).toHaveBeenCalledTimes(1);
    expect(updateDesignPortalVisibility).toHaveBeenCalledWith(VALID_ID, {
      portalShowStreetView: false,
      portalShowSatelliteView: false,
    });
  });

  it('does not stale-overwrite street visibility in a satellite-only request', async () => {
    updateDesignPortalVisibility.mockResolvedValueOnce({
      portalShowStreetView: false,
      portalShowSatelliteView: true,
    });

    const res = await PUT(makeReq({ portalShowSatelliteView: true }), ctx());

    expect(res.status).toBe(200);
    expect(updateDesignPortalVisibility).toHaveBeenCalledWith(VALID_ID, {
      portalShowSatelliteView: true,
    });
    expect(await res.json()).toMatchObject({
      portalShowStreetView: false,
      portalShowSatelliteView: true,
    });
  });

  it('is safe to repeat the same portal visibility request', async () => {
    updateDesignPortalVisibility.mockResolvedValue({
      portalShowStreetView: false,
      portalShowSatelliteView: true,
    });

    const first = await PUT(makeReq({ portalShowStreetView: false }), ctx());
    const second = await PUT(makeReq({ portalShowStreetView: false }), ctx());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
    expect(linkDesignToQuote).not.toHaveBeenCalled();
    expect(updateDesignSatelliteLines).not.toHaveBeenCalled();
  });

  it('500s when portal visibility persistence fails', async () => {
    updateDesignPortalVisibility.mockResolvedValueOnce(null);
    const res = await PUT(makeReq({ portalShowSatelliteView: false }), ctx());
    expect(res.status).toBe(500);
  });

  it('400s a malformed scene', async () => {
    const res = await PUT(makeReq({ scene: { items: [] } }), ctx()); // missing yardsticks
    expect(res.status).toBe(400);
    expect(updateDesignSceneGuarded).not.toHaveBeenCalled();
  });

  it('400s a non-integer version alongside a scene', async () => {
    const res = await PUT(makeReq({ scene: validScene, version: 1.5 }), ctx());
    expect(res.status).toBe(400);
    expect(updateDesignSceneGuarded).not.toHaveBeenCalled();
  });

  it('400s a string version alongside a scene', async () => {
    const res = await PUT(makeReq({ scene: validScene, version: '3' }), ctx());
    expect(res.status).toBe(400);
    expect(updateDesignSceneGuarded).not.toHaveBeenCalled();
  });

  it('400s a malformed satelliteLines (no array channel / a non-array channel)', async () => {
    // #88/S23: channels are independent (holiday sends santas/gingerbread/c9;
    // permanent sends front/left/right/back) — validation rejects a body with no
    // array channel or a channel of the wrong type.
    expect((await PUT(makeReq({ satelliteLines: { santas: 'nope' } }), ctx())).status).toBe(400);
    expect((await PUT(makeReq({ satelliteLines: {} }), ctx())).status).toBe(400);
    expect(updateDesignSatelliteLines).not.toHaveBeenCalled();
  });

  it('saves permanent side-only satelliteLines (front/left/right/back)', async () => {
    const permLines = { front: [{ points: [[0.1, 0.5], [0.9, 0.5]], label: 'Front roofline' }], left: [], right: [], back: [] };
    const res = await PUT(makeReq({ satelliteLines: permLines }), ctx());
    expect(res.status).toBe(200);
    expect(updateDesignSatelliteLines).toHaveBeenCalledWith(VALID_ID, permLines);
  });

  // #117: a bistro-only body ({ bistro: [...] }) must validate + persist — the
  // channel allow-list originally omitted 'bistro', so every satellite-run
  // write silently 400'd (fire-and-forget on the client), losing all runs.
  it('saves bistro-only satelliteLines ({ bistro })', async () => {
    const bistroLines = { bistro: [{ points: [[0.2, 0.4], [0.8, 0.45]], label: 'Run 1' }] };
    const res = await PUT(makeReq({ satelliteLines: bistroLines }), ctx());
    expect(res.status).toBe(200);
    expect(updateDesignSatelliteLines).toHaveBeenCalledWith(VALID_ID, bistroLines);
  });

  it('400s an invalid quoteId', async () => {
    const res = await PUT(makeReq({ quoteId: 'not-a-uuid' }), ctx());
    expect(res.status).toBe(400);
    expect(linkDesignToQuote).not.toHaveBeenCalled();
  });

  it('saves a scene-only update successfully, round-tripping version through the CAS guard', async () => {
    const res = await PUT(makeReq({ scene: validScene, version: 4 }), ctx());
    expect(res.status).toBe(200);
    expect(updateDesignSceneGuarded).toHaveBeenCalledWith(VALID_ID, validScene, 4);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.version).toBe(2); // whatever updateDesignSceneGuarded's mock returned
  });

  it('saves a scene carrying per-photo brightness through the CAS guard', async () => {
    const perPhotoScene = {
      ...validScene,
      brightness: 20,
      extraPhotoBrightness: { 'left-photo': 65 },
    };
    const res = await PUT(makeReq({ scene: perPhotoScene, version: 4 }), ctx());
    expect(res.status).toBe(200);
    expect(updateDesignSceneGuarded).toHaveBeenCalledWith(VALID_ID, perPhotoScene, 4);
  });

  // Row 348 FIX ROUND: the per-photo map filters rather than coerces, and this
  // pins why. `brightnessForPhoto` reads
  // `extraPhotoBrightness?.[photoId] ?? baseBrightness`, so a null/garbage entry
  // INHERITS the scene's brightness. `clampBrightness` returns 50 for anything
  // non-numeric — correct for the scene-level field (which already defaults with
  // `?? 50`) but wrong per photo, where it would silently pin that photo at 50
  // and stop it inheriting. Dropping the unusable entry preserves the inherit
  // behaviour exactly, since a missing key reads identically to a null one.
  it('DROPS a non-numeric per-photo brightness so it keeps inheriting the base, never pins it to 50', async () => {
    const scene = {
      ...validScene,
      brightness: 80,
      extraPhotoBrightness: { 'left-photo': null, 'mid-photo': undefined, 'right-photo': 40 },
    } as unknown as Record<string, unknown>;
    const res = await PUT(makeReq({ scene, version: 4 }), ctx());
    expect(res.status).toBe(200);
    const persisted = (updateDesignSceneGuarded as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1] as {
      extraPhotoBrightness: Record<string, number>;
      brightness: number;
    };
    // The unusable entries are gone entirely — NOT rewritten to 50.
    expect(persisted.extraPhotoBrightness).toEqual({ 'right-photo': 40 });
    expect(persisted.extraPhotoBrightness['left-photo']).toBeUndefined();
    // ...and the scene-level value still clamps normally.
    expect(persisted.brightness).toBe(80);
  });

  // Row 348 (admin LOW): a caller-supplied brightness outside [0,100] must be
  // clamped before it reaches storage — nothing downstream clamps it on read
  // the way lightScale is (see photoBrightness.ts's clampBrightness comment).
  it('clamps an out-of-range brightness (base + per-photo) before persisting', async () => {
    const wildScene = {
      ...validScene,
      brightness: 9000,
      extraPhotoBrightness: { 'left-photo': -50, 'right-photo': 40 },
    };
    const res = await PUT(makeReq({ scene: wildScene, version: 4 }), ctx());
    expect(res.status).toBe(200);
    expect(updateDesignSceneGuarded).toHaveBeenCalledWith(
      VALID_ID,
      {
        ...validScene,
        brightness: 100,
        extraPhotoBrightness: { 'left-photo': 0, 'right-photo': 40 },
      },
      4,
    );
  });

  it('treats an omitted version as null (the adopt path) rather than crashing', async () => {
    const res = await PUT(makeReq({ scene: validScene }), ctx());
    expect(res.status).toBe(200);
    expect(updateDesignSceneGuarded).toHaveBeenCalledWith(VALID_ID, validScene, undefined);
  });

  it('preserves a mini-group color pattern in the opaque scene update', async () => {
    const scene = {
      yardsticks: [],
      items: [{
        id: 'group-1',
        kind: 'miniGroup',
        yardstickId: null,
        memberIds: ['member-1', 'member-2'],
        surface: 'railing',
        stringCount: 3,
        colorPattern: ['red', 'green'],
      }],
    };

    const res = await PUT(makeReq({ scene }), ctx());

    expect(res.status).toBe(200);
    expect(updateDesignSceneGuarded).toHaveBeenCalledWith(VALID_ID, scene, undefined);
  });

  it('saves satelliteLines successfully', async () => {
    const res = await PUT(makeReq({ satelliteLines: validSatelliteLines }), ctx());
    expect(res.status).toBe(200);
    expect(updateDesignSatelliteLines).toHaveBeenCalledWith(VALID_ID, validSatelliteLines);
  });

  it('links the design to a quote successfully', async () => {
    const res = await PUT(makeReq({ quoteId: OTHER_ID }), ctx());
    expect(res.status).toBe(200);
    expect(linkDesignToQuote).toHaveBeenCalledWith(VALID_ID, OTHER_ID);
  });

  it('409s a link conflict (design already linked to a different quote)', async () => {
    linkDesignToQuote.mockResolvedValueOnce(false);
    const res = await PUT(makeReq({ quoteId: OTHER_ID }), ctx());
    expect(res.status).toBe(409);
  });

  it('500s when updateDesignSceneGuarded reports a non-conflict failure', async () => {
    updateDesignSceneGuarded.mockResolvedValueOnce({ ok: false, reason: 'error' });
    const res = await PUT(makeReq({ scene: validScene }), ctx());
    expect(res.status).toBe(500);
  });

  // Ledger row 260: a lost CAS race must come back as a DISTINGUISHABLE 409 —
  // not a generic 500 — so the editor can block-and-offer-reload instead of
  // its ordinary auto-retry (which would just resend the same stale overwrite).
  it('409s a scene conflict (lost the compare-and-swap race)', async () => {
    updateDesignSceneGuarded.mockResolvedValueOnce({ ok: false, reason: 'conflict' });
    const res = await PUT(makeReq({ scene: validScene, version: 3 }), ctx());
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.conflict).toBe(true);
  });
});
