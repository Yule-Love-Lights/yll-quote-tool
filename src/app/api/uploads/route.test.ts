// #110 W2-024: the route's filename fallback regex must not accept .svg —
// the lib (isAllowedImageType/extFor) deliberately rejects SVG, but the route
// let a .svg filename through its own check and 500'd instead of a clean 400.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { createCustomUpload, isAllowedImageType } = vi.hoisted(() => ({
  createCustomUpload: vi.fn(async () => ({ id: 'u1', filename: 'x.png', path: 'x.png', url: 'https://x' })),
  isAllowedImageType: vi.fn((t: string) => ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(t)),
}));

vi.mock('@/lib/customUploads', () => ({
  listCustomUploads: vi.fn(async () => []),
  createCustomUpload,
  isAllowedImageType,
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: async () => null,
}));

import { POST } from './route';

function makeFile(name: string, type: string, size = 10): File {
  return new File([new Uint8Array(size)], name, { type });
}

function makeReq(file: File): NextRequest {
  const form = new FormData();
  form.set('file', file);
  return { formData: async () => form } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  createCustomUpload.mockResolvedValue({ id: 'u1', filename: 'x.png', path: 'x.png', url: 'https://x' });
});

describe('POST /api/uploads — SVG rejection (#110 W2-024)', () => {
  it('400s a .svg filename with an unrecognized content type (never reaches the lib)', async () => {
    const res = await POST(makeReq(makeFile('evil.svg', 'application/octet-stream')));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/unsupported/i);
    expect(createCustomUpload).not.toHaveBeenCalled();
  });

  it('still accepts a .png filename with an unrecognized content type', async () => {
    const res = await POST(makeReq(makeFile('ok.png', 'application/octet-stream')));
    expect(res.status).toBe(200);
    expect(createCustomUpload).toHaveBeenCalled();
  });
});
