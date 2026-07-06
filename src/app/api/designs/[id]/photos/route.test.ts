// #110 W6-002: POST /photos must 404 on a nonexistent (but valid-format) design
// id instead of uploading the blob (orphaned blob, 500 from the downstream
// atomic update). Mirrors photo/route.test.ts (#110 W2-008).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { addDesignExtraPhoto, getDesign, sign } = vi.hoisted(() => ({
  addDesignExtraPhoto: vi.fn(async () => ({ id: 'p1', path: 'd1/extra/p1.jpg', w: 100, h: 200, title: null })),
  getDesign: vi.fn(async (): Promise<{ id: string } | null> => ({ id: 'd1' })),
  sign: vi.fn(async () => 'https://signed.example/extra.jpg'),
}));

vi.mock('@/lib/designs', () => ({
  addDesignExtraPhoto,
  signDesignPhoto: sign,
  getDesign,
  isValidDesignId: (id: unknown) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: async () => null,
}));

import { POST } from './route';

const VALID_ID = '11111111-1111-1111-1111-111111111111';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  addDesignExtraPhoto.mockResolvedValue({ id: 'p1', path: 'd1/extra/p1.jpg', w: 100, h: 200, title: null });
  getDesign.mockResolvedValue({ id: 'd1' });
  sign.mockResolvedValue('https://signed.example/extra.jpg');
});

describe('POST /api/designs/[id]/photos — existence check (#110 W6-002)', () => {
  it('404s and never uploads when the design does not exist', async () => {
    getDesign.mockResolvedValue(null);
    const res = await POST(makeReq({ photoBase64: 'abc' }), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
    expect(addDesignExtraPhoto).not.toHaveBeenCalled();
  });

  it('uploads and returns 200 when the design exists', async () => {
    const res = await POST(makeReq({ photoBase64: 'abc' }), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.photo.url).toBe('https://signed.example/extra.jpg');
    expect(addDesignExtraPhoto).toHaveBeenCalledWith(VALID_ID, 'abc', 'image/jpeg', null);
  });
});
