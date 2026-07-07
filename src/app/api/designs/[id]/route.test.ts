// #110 W6-011: GET/PUT /api/designs/[id] (the editor's continuously-called
// autosave endpoint — updateDesignScene / linkDesignToQuote /
// updateDesignSatelliteLines) had zero route-level test coverage, unlike its
// sibling design sub-routes. requireOperator, Supabase config, and lib/designs
// mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const {
  getDesignWithPhoto,
  updateDesignScene,
  linkDesignToQuote,
  updateDesignSatelliteLines,
  requireOperatorMock,
  isConfigured,
} = vi.hoisted(() => ({
  getDesignWithPhoto: vi.fn(),
  updateDesignScene: vi.fn(),
  linkDesignToQuote: vi.fn(),
  updateDesignSatelliteLines: vi.fn(),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  isConfigured: { current: true },
}));

vi.mock('@/lib/designs', () => ({
  getDesignWithPhoto,
  updateDesignScene,
  linkDesignToQuote,
  updateDesignSatelliteLines,
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
  getDesignWithPhoto.mockResolvedValue({ id: VALID_ID, scene: validScene });
  updateDesignScene.mockResolvedValue(true);
  linkDesignToQuote.mockResolvedValue(true);
  updateDesignSatelliteLines.mockResolvedValue(true);
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
    expect(updateDesignScene).not.toHaveBeenCalled();
  });

  it('503s when Supabase service role is not configured', async () => {
    isConfigured.current = false;
    const res = await PUT(makeReq({ scene: validScene }), ctx());
    expect(res.status).toBe(503);
  });

  it('400s an invalid id', async () => {
    const res = await PUT(makeReq({ scene: validScene }), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('400s invalid JSON', async () => {
    const req = { json: async () => { throw new Error('bad'); } } as unknown as NextRequest;
    const res = await PUT(req, ctx());
    expect(res.status).toBe(400);
  });

  it('400s when none of scene/quoteId/satelliteLines are provided', async () => {
    const res = await PUT(makeReq({}), ctx());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/nothing to update/i);
  });

  it('400s a malformed scene', async () => {
    const res = await PUT(makeReq({ scene: { items: [] } }), ctx()); // missing yardsticks
    expect(res.status).toBe(400);
    expect(updateDesignScene).not.toHaveBeenCalled();
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

  it('400s an invalid quoteId', async () => {
    const res = await PUT(makeReq({ quoteId: 'not-a-uuid' }), ctx());
    expect(res.status).toBe(400);
    expect(linkDesignToQuote).not.toHaveBeenCalled();
  });

  it('saves a scene-only update successfully', async () => {
    const res = await PUT(makeReq({ scene: validScene }), ctx());
    expect(res.status).toBe(200);
    expect(updateDesignScene).toHaveBeenCalledWith(VALID_ID, validScene);
    const json = await res.json();
    expect(json.ok).toBe(true);
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

  it('500s when updateDesignScene reports failure', async () => {
    updateDesignScene.mockResolvedValueOnce(false);
    const res = await PUT(makeReq({ scene: validScene }), ctx());
    expect(res.status).toBe(500);
  });
});
