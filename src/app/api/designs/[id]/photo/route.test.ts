// #110 W2-008: POST /photo must 404 on a nonexistent (but valid-format) design
// id instead of uploading the blob and updating zero rows (orphaned blob, 200).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const { upload, getDesign, sign } = vi.hoisted(() => ({
  upload: vi.fn(async () => ({ path: 'd1/photo.jpg', width: 100, height: 200 })),
  getDesign: vi.fn(async (): Promise<{ id: string } | null> => ({ id: 'd1' })),
  sign: vi.fn(async () => 'https://signed.example/photo.jpg'),
}));

vi.mock('@/lib/designs', () => ({
  uploadDesignPhoto: upload,
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
  upload.mockResolvedValue({ path: 'd1/photo.jpg', width: 100, height: 200 });
  getDesign.mockResolvedValue({ id: 'd1' });
  sign.mockResolvedValue('https://signed.example/photo.jpg');
});

describe('POST /api/designs/[id]/photo — existence check (#110 W2-008)', () => {
  it('404s and never uploads when the design does not exist', async () => {
    getDesign.mockResolvedValue(null);
    const res = await POST(makeReq({ photoBase64: 'abc' }), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toMatch(/not found/i);
    expect(upload).not.toHaveBeenCalled();
  });

  it('uploads and returns 200 when the design exists', async () => {
    const res = await POST(makeReq({ photoBase64: 'abc' }), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.photoUrl).toBe('https://signed.example/photo.jpg');
    expect(upload).toHaveBeenCalledWith(VALID_ID, 'abc', 'image/jpeg');
  });
});

// Row 427: replacing the BASE PHOTO changes the picture the customer approved.
// Three premerge lenses on PR #998 found this route had no freeze check at all,
// so the "Move the Camera" buttons could swap it silently on an approved quote.
describe('POST /api/designs/[id]/photo — post-approval freeze (row 427)', () => {
  it('refuses before uploading anything', async () => {
    refuseIfFrozenMock.mockResolvedValueOnce(
      NextResponse.json({ error: 'locked', code: 'design-locked' }, { status: 409 }),
    );
    const res = await POST(makeReq({ photoBase64: 'abc' }), { params: Promise.resolve({ id: VALID_ID }) });
    expect(res.status).toBe(409);
    expect(upload).not.toHaveBeenCalled();
  });
});
