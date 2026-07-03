// #110 W5-005/W5-018: POST /api/training inserted a fully unvalidated body into
// training_houses (only body.photos.length was checked), so an attacker/typo'd
// footage, difficulty, or detection stringCount would poison the analyzer
// few-shot corpus (reopens #80-036). Clamp/coerce before saveTrainingHouse,
// mirroring the scene-correction sanitizers in sceneCorrections.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { TrainingHousePayload } from '@/lib/training';

const { saveTrainingHouse } = vi.hoisted(() => ({
  saveTrainingHouse: vi.fn(async (_payload: TrainingHousePayload) => ({ id: 'h1' })),
}));

vi.mock('@/lib/training', () => ({ saveTrainingHouse }));
vi.mock('@/lib/supabase', () => ({ isSupabaseConfigured: () => true }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: async () => null }));

import { POST } from './route';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const PHOTO = { tag: 'front_install', base64: 'AAAA', mediaType: 'image/jpeg' };

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    photos: [PHOTO],
    santasLines: [],
    gingerbreadLines: [],
    miniLightDetections: [],
    spritzers: [],
    wreaths: [],
    garland: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  saveTrainingHouse.mockResolvedValue({ id: 'h1' });
});

describe('POST /api/training — payload sanitization (#110 W5-005)', () => {
  it('clamps a negative footage to 0', async () => {
    const res = await POST(makeReq(basePayload({ santasFootage: -50, gingerbreadFootage: -1 })));
    expect(res.status).toBe(200);
    const saved = saveTrainingHouse.mock.calls[0][0];
    expect(saved.santasFootage).toBe(0);
    expect(saved.gingerbreadFootage).toBe(0);
  });

  it('clamps a non-finite / NaN footage to 0', async () => {
    const res = await POST(makeReq(basePayload({ santasFootage: NaN, gingerbreadFootage: Infinity })));
    expect(res.status).toBe(200);
    const saved = saveTrainingHouse.mock.calls[0][0];
    expect(saved.santasFootage).toBe(0);
    expect(saved.gingerbreadFootage).toBe(0);
  });

  it('rejects an absurdly large footage (clamps to a sane max)', async () => {
    const res = await POST(makeReq(basePayload({ santasFootage: 1_000_000 })));
    expect(res.status).toBe(200);
    const saved = saveTrainingHouse.mock.calls[0][0];
    expect(saved.santasFootage).toBeLessThanOrEqual(100_000);
  });

  it('coerces an invalid difficulty string to the default allowed set', async () => {
    const res = await POST(makeReq(basePayload({ santasDifficulty: 'extreme; DROP TABLE', gingerbreadDifficulty: 'hard' })));
    expect(res.status).toBe(200);
    const saved = saveTrainingHouse.mock.calls[0][0];
    expect(['easy', 'medium', 'hard']).toContain(saved.santasDifficulty);
    expect(saved.gingerbreadDifficulty).toBe('hard');
  });

  it('clamps an oversized mini-light detection stringCount to MAX (500)', async () => {
    const res = await POST(makeReq(basePayload({
      miniLightDetections: [
        { type: 'bush', wrapStyle: 'canopy', stringCount: 999999, box: [0, 0, 0.1, 0.1], label: 'x' },
      ],
    })));
    expect(res.status).toBe(200);
    const saved = saveTrainingHouse.mock.calls[0][0];
    expect(saved.miniLightDetections[0].stringCount).toBeLessThanOrEqual(500);
  });

  it('drops a detection with an out-of-range box rather than trusting it verbatim', async () => {
    const res = await POST(makeReq(basePayload({
      miniLightDetections: [
        { type: 'tree', wrapStyle: 'trunk', stringCount: 3, box: [2, -1, 5, 5], label: 'bad' },
      ],
    })));
    expect(res.status).toBe(200);
    const saved = saveTrainingHouse.mock.calls[0][0];
    expect(saved.miniLightDetections).toHaveLength(0);
  });

  it('still 400s when no photos are provided', async () => {
    const res = await POST(makeReq(basePayload({ photos: [] })));
    expect(res.status).toBe(400);
    expect(saveTrainingHouse).not.toHaveBeenCalled();
  });

  it('passes a well-formed payload through with values intact', async () => {
    const res = await POST(makeReq(basePayload({ santasFootage: 42, santasDifficulty: 'easy' })));
    expect(res.status).toBe(200);
    const saved = saveTrainingHouse.mock.calls[0][0];
    expect(saved.santasFootage).toBe(42);
    expect(saved.santasDifficulty).toBe('easy');
  });
});
