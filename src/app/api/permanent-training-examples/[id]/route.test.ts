// WT-37: the permanent training-examples PATCH route gained a corrections
// editor path (finalSatelliteLines / finalStreetRuns / finalInputs) alongside
// the existing excluded/notes toggle. requireOperator, Supabase config, the
// permanent trainingExamples lib, and the direct Supabase update call (used
// for corrections — see route.ts's persistPermanentCorrections) are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const {
  getPermanentTrainingExample,
  updatePermanentTrainingExample,
  deletePermanentTrainingExample,
  requireOperatorMock,
  isConfigured,
  sbUpdateMock,
  sbEqMock,
} = vi.hoisted(() => ({
  getPermanentTrainingExample: vi.fn(),
  updatePermanentTrainingExample: vi.fn(),
  deletePermanentTrainingExample: vi.fn(),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  isConfigured: { current: true },
  sbUpdateMock: vi.fn(),
  sbEqMock: vi.fn(async (): Promise<{ error: null | { message: string } }> => ({ error: null })),
}));

vi.mock('@/lib/permanent/trainingExamples', () => ({
  getPermanentTrainingExample,
  updatePermanentTrainingExample,
  deletePermanentTrainingExample,
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => isConfigured.current,
  getSupabaseServiceClient: () => ({
    from: () => ({ update: sbUpdateMock }),
  }),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
}));

import { GET, PATCH, DELETE } from './route';

const VALID_ID = '11111111-1111-1111-1111-111111111111';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const ctx = (id = VALID_ID) => ({ params: Promise.resolve({ id }) });
const getReq = {} as NextRequest;

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const validLines = {
  front: [{ points: [[0.1, 0.5], [0.9, 0.5]], label: 'front gutter' }],
  left: [],
  right: [],
  back: [],
};
const validRuns = [{ side: 'front', points: [[0.2, 0.4], [0.8, 0.45]], label: 'run 1' }];
const validInputs = {
  frontFootage: 40, leftFootage: 20, rightFootage: 20, backFootage: 0,
  frontCorners: 2, leftCorners: 1, rightCorners: 1, backCorners: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  isConfigured.current = true;
  getPermanentTrainingExample.mockResolvedValue({ id: VALID_ID });
  updatePermanentTrainingExample.mockResolvedValue(true);
  deletePermanentTrainingExample.mockResolvedValue(true);
  sbUpdateMock.mockReturnValue({ eq: sbEqMock });
  sbEqMock.mockResolvedValue({ error: null });
});

describe('GET /api/permanent-training-examples/[id]', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await GET(getReq, ctx());
    expect(res.status).toBe(401);
  });

  it('404s when the example does not exist', async () => {
    getPermanentTrainingExample.mockResolvedValueOnce(null);
    const res = await GET(getReq, ctx());
    expect(res.status).toBe(404);
  });

  it('returns the example on success', async () => {
    const res = await GET(getReq, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.example.id).toBe(VALID_ID);
  });
});

describe('PATCH /api/permanent-training-examples/[id]', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await PATCH(makeReq({ excluded: true }), ctx());
    expect(res.status).toBe(401);
    expect(updatePermanentTrainingExample).not.toHaveBeenCalled();
  });

  it('503s when Supabase service role is not configured', async () => {
    isConfigured.current = false;
    const res = await PATCH(makeReq({ excluded: true }), ctx());
    expect(res.status).toBe(503);
  });

  it('400s an invalid id', async () => {
    const res = await PATCH(makeReq({ excluded: true }), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('400s invalid JSON', async () => {
    const req = { json: async () => { throw new Error('bad'); } } as unknown as NextRequest;
    const res = await PATCH(req, ctx());
    expect(res.status).toBe(400);
  });

  it('400s when nothing is provided', async () => {
    const res = await PATCH(makeReq({}), ctx());
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/nothing to update/i);
  });

  it('still toggles excluded/notes as before (no correction fields)', async () => {
    const res = await PATCH(makeReq({ excluded: true, notes: 'oddball' }), ctx());
    expect(res.status).toBe(200);
    expect(updatePermanentTrainingExample).toHaveBeenCalledWith(VALID_ID, { excluded: true, notes: 'oddball' });
    expect(sbUpdateMock).not.toHaveBeenCalled();
  });

  it('500s when the simple update fails', async () => {
    updatePermanentTrainingExample.mockResolvedValueOnce(false);
    const res = await PATCH(makeReq({ excluded: true }), ctx());
    expect(res.status).toBe(500);
  });

  // --- WT-37 correction fields ---

  it('persists a valid finalSatelliteLines correction', async () => {
    const res = await PATCH(makeReq({ finalSatelliteLines: validLines }), ctx());
    expect(res.status).toBe(200);
    expect(sbUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ final_satellite_lines: expect.objectContaining({ front: expect.any(Array) }) }),
    );
    expect(sbEqMock).toHaveBeenCalledWith('id', VALID_ID);
    expect(updatePermanentTrainingExample).not.toHaveBeenCalled();
  });

  it('persists a valid finalStreetRuns correction', async () => {
    const res = await PATCH(makeReq({ finalStreetRuns: validRuns }), ctx());
    expect(res.status).toBe(200);
    expect(sbUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ final_street_runs: validRuns }),
    );
  });

  it('persists a valid finalInputs correction', async () => {
    const res = await PATCH(makeReq({ finalInputs: validInputs }), ctx());
    expect(res.status).toBe(200);
    expect(sbUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ final_inputs: expect.objectContaining({ frontFootage: 40 }) }),
    );
  });

  it('persists correction fields AND the simple excluded/notes patch together', async () => {
    const res = await PATCH(makeReq({ excluded: false, finalInputs: validInputs }), ctx());
    expect(res.status).toBe(200);
    expect(updatePermanentTrainingExample).toHaveBeenCalledWith(VALID_ID, { excluded: false });
    expect(sbUpdateMock).toHaveBeenCalled();
  });

  it('clamps an out-of-range point into 0-1 instead of rejecting it', async () => {
    const lines = { front: [{ points: [[-0.2, 1.4], [0.9, 0.5]], label: 'front' }], left: [], right: [], back: [] };
    const res = await PATCH(makeReq({ finalSatelliteLines: lines }), ctx());
    expect(res.status).toBe(200);
    const persisted = sbUpdateMock.mock.calls[0][0] as { final_satellite_lines: { front: { points: number[][] }[] } };
    expect(persisted.final_satellite_lines.front[0].points[0]).toEqual([0, 1]);
  });

  it('400s finalSatelliteLines with a line that has fewer than 2 points', async () => {
    const lines = { front: [{ points: [[0.1, 0.5]], label: 'front' }], left: [], right: [], back: [] };
    const res = await PATCH(makeReq({ finalSatelliteLines: lines }), ctx());
    expect(res.status).toBe(400);
    expect(sbUpdateMock).not.toHaveBeenCalled();
  });

  it('400s finalSatelliteLines with a non-array side channel', async () => {
    const res = await PATCH(makeReq({ finalSatelliteLines: { front: 'nope', left: [], right: [], back: [] } }), ctx());
    expect(res.status).toBe(400);
  });

  it('400s finalStreetRuns with an invalid side', async () => {
    const res = await PATCH(
      makeReq({ finalStreetRuns: [{ side: 'back', points: [[0.1, 0.1], [0.2, 0.2]], label: 'x' }] }),
      ctx(),
    );
    expect(res.status).toBe(400);
    expect(sbUpdateMock).not.toHaveBeenCalled();
  });

  it('400s finalInputs missing a required footage field', async () => {
    const { backFootage: _drop, ...incomplete } = validInputs;
    const res = await PATCH(makeReq({ finalInputs: incomplete }), ctx());
    expect(res.status).toBe(400);
    expect(sbUpdateMock).not.toHaveBeenCalled();
  });

  it('400s finalInputs with a negative footage value', async () => {
    const res = await PATCH(makeReq({ finalInputs: { ...validInputs, frontFootage: -5 } }), ctx());
    expect(res.status).toBe(400);
  });

  it('500s when the correction persist call errors', async () => {
    sbEqMock.mockResolvedValueOnce({ error: { message: 'db down' } });
    const res = await PATCH(makeReq({ finalInputs: validInputs }), ctx());
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/permanent-training-examples/[id]', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await DELETE(getReq as unknown as NextRequest, ctx());
    expect(res.status).toBe(401);
  });

  it('deletes successfully', async () => {
    const res = await DELETE(getReq as unknown as NextRequest, ctx());
    expect(res.status).toBe(200);
    expect(deletePermanentTrainingExample).toHaveBeenCalledWith(VALID_ID);
  });

  it('500s when delete fails', async () => {
    deletePermanentTrainingExample.mockResolvedValueOnce(false);
    const res = await DELETE(getReq as unknown as NextRequest, ctx());
    expect(res.status).toBe(500);
  });
});
