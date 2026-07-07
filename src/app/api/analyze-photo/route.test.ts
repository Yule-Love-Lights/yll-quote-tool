// #110 W5-002: POST /api/analyze-photo had zero route-level test coverage,
// including the design|completed mode selection (line 51) that decides
// whether /training/new's upload becomes COMPLETED_INSTALL ground truth or a
// SUGGEST-placements design draft. Covers the mode gate + the success/outage
// (fail-safe) paths, mirroring the analyze-address route-test mock style.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { analyzePhoto, assembleFewShot } = vi.hoisted(() => ({
  analyzePhoto: vi.fn(),
  assembleFewShot: vi.fn(),
}));

vi.mock('@/lib/claude', () => ({ isClaudeConfigured: () => true }));
vi.mock('@/lib/photoAnalysis', () => ({
  analyzePhoto,
  ANALYZER_UNAVAILABLE_MESSAGE: 'unavailable',
}));
vi.mock('@/lib/fewShot', () => ({ assembleFewShot }));
vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: async () => null }));

import { POST } from './route';

function makeFile(name: string, type: string, size = 10): File {
  return new File([new Uint8Array(size)], name, { type });
}

function makeReq(fields: Record<string, string | File>): NextRequest {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return { formData: async () => form } as unknown as NextRequest;
}

const FEW_SHOT = { examples: [], references: [], biasNote: null, breakdown: { ranking: 'recency' as const } };

beforeEach(() => {
  vi.clearAllMocks();
  assembleFewShot.mockResolvedValue(FEW_SHOT);
  analyzePhoto.mockResolvedValue({ santasFootage: 10 });
});

describe('POST /api/analyze-photo — mode selection (#110 W5-002)', () => {
  it('defaults to design mode when mode is absent', async () => {
    await POST(makeReq({ photo: makeFile('house.jpg', 'image/jpeg') }));
    expect(analyzePhoto).toHaveBeenCalledWith(
      expect.any(String), 'image/jpeg', FEW_SHOT.examples,
      expect.objectContaining({ mode: 'design' }),
    );
  });

  it('forwards mode:"completed" when the form sends mode=completed (/training/new)', async () => {
    await POST(makeReq({ photo: makeFile('house.jpg', 'image/jpeg'), mode: 'completed' }));
    expect(analyzePhoto).toHaveBeenCalledWith(
      expect.any(String), 'image/jpeg', FEW_SHOT.examples,
      expect.objectContaining({ mode: 'completed' }),
    );
  });

  it('falls back to design mode for any other mode value', async () => {
    await POST(makeReq({ photo: makeFile('house.jpg', 'image/jpeg'), mode: 'bogus' }));
    expect(analyzePhoto).toHaveBeenCalledWith(
      expect.any(String), 'image/jpeg', FEW_SHOT.examples,
      expect.objectContaining({ mode: 'design' }),
    );
  });
});

describe('POST /api/analyze-photo — success path', () => {
  it('returns the analyzer result plus few-shot metadata', async () => {
    const res = await POST(makeReq({ photo: makeFile('house.jpg', 'image/jpeg') }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result).toEqual({ santasFootage: 10 });
    expect(json.analysisUnavailable).toBe(false);
    expect(json.analysisError).toBeUndefined();
    expect(json.fewShotCount).toBe(0);
    expect(json.fewShotBreakdown).toEqual({ ranking: 'recency' });
    expect(typeof json.photoBase64).toBe('string');
    expect(json.photoMediaType).toBe('image/jpeg');
  });
});

describe('POST /api/analyze-photo — outage fail-safe path', () => {
  it('returns result:null + the unavailable message when analyzePhoto throws, but still returns the photo', async () => {
    analyzePhoto.mockRejectedValueOnce(new Error('Claude is down'));
    const res = await POST(makeReq({ photo: makeFile('house.jpg', 'image/jpeg') }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result).toBeNull();
    expect(json.analysisUnavailable).toBe(true);
    expect(json.analysisError).toBe('unavailable');
    expect(typeof json.photoBase64).toBe('string'); // staff can still design manually
  });

  it('returns result:null when assembleFewShot itself throws', async () => {
    assembleFewShot.mockRejectedValueOnce(new Error('embedding service down'));
    const res = await POST(makeReq({ photo: makeFile('house.jpg', 'image/jpeg') }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result).toBeNull();
    expect(json.analysisUnavailable).toBe(true);
  });
});

describe('POST /api/analyze-photo — input validation (existing behavior, guarded)', () => {
  it('400s when no photo field is present', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
    expect(analyzePhoto).not.toHaveBeenCalled();
  });

  it('400s a non-image file', async () => {
    const res = await POST(makeReq({ photo: makeFile('doc.pdf', 'application/pdf') }));
    expect(res.status).toBe(400);
    expect(analyzePhoto).not.toHaveBeenCalled();
  });

  it('400s a HEIC upload with a clear format message instead of the outage fail-safe', async () => {
    const res = await POST(makeReq({ photo: makeFile('photo.heic', 'image/heic') }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/unsupported image format/i);
    expect(json.error).not.toBe('unavailable');
    expect(analyzePhoto).not.toHaveBeenCalled();
  });

  it('400s an oversized photo', async () => {
    const res = await POST(makeReq({ photo: makeFile('big.jpg', 'image/jpeg', 11 * 1024 * 1024) }));
    expect(res.status).toBe(400);
    expect(analyzePhoto).not.toHaveBeenCalled();
  });
});
