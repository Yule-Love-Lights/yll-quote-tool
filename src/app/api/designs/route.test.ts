// #90 actor audit trail: POST /api/designs threads the authenticated operator id
// to createDesign as created_by.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { create, operatorRef } = vi.hoisted(() => ({
  create: vi.fn(async () => ({ id: 'd1' })),
  operatorRef: { current: null as { id: string; email: string | null; role: string } | null },
}));

vi.mock('@/lib/designs', () => ({
  createDesign: create,
  getDesignWithPhoto: vi.fn(async () => ({ id: 'd1' })),
  isValidDesignId: () => false,
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: async () => null,
  getOperator: async () => operatorRef.current,
}));

import { POST } from './route';

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  operatorRef.current = null;
});

describe('POST /api/designs — created_by actor trail (#90)', () => {
  it('threads the authenticated operator id to createDesign', async () => {
    operatorRef.current = { id: 'op-1', email: 'a@b.com', role: 'operator' };
    const res = await POST(makeReq({}));
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'op-1' }));
  });

  it('threads null when no operator session (dormant auth)', async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(200);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ createdBy: null }));
  });
});
