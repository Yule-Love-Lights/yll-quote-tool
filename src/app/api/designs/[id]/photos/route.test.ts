// #110 W6-002: POST /photos must 404 on a nonexistent (but valid-format) design
// id instead of uploading the blob (orphaned blob, 500 from the downstream
// atomic update). Mirrors photo/route.test.ts (#110 W2-008).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
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


// Row 427: every design write route now shares ONE post-approval refusal
// (sceneFreeze's refuseIfFrozen). Mocked here so these tests stay about the
// route's own behaviour; the refusal itself is covered in sceneFreeze.test.ts,
// and each route's freeze mapping has its own test below.
const { refuseIfFrozenMock } = vi.hoisted(() => ({
  refuseIfFrozenMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/design/sceneFreeze', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/design/sceneFreeze')>()),
  refuseIfFrozen: refuseIfFrozenMock,
}));

import { POST } from './route';

const VALID_ID = '11111111-1111-1111-1111-111111111111';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  refuseIfFrozenMock.mockResolvedValue(null);
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

// Row 427: an extra photo is quoted and shown like any other, so adding one to
// a signed-off design changes what the customer agreed to.
describe('POST /api/designs/[id]/photos — post-approval freeze (row 427)', () => {
  it('refuses before adding anything', async () => {
    refuseIfFrozenMock.mockResolvedValueOnce(
      NextResponse.json({ error: 'locked', code: 'design-locked' }, { status: 409 }),
    );
    const res = await POST(makeReq({ photoBase64: 'abc' }), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(409);
    expect(addDesignExtraPhoto).not.toHaveBeenCalled();
  });
});
