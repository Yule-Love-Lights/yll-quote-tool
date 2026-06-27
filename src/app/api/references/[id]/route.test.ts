// Audit fix (id-route-uuid-guards): a non-UUID [id] must be rejected with 400
// BEFORE the DB layer runs — otherwise Postgres raises 22P02 and it surfaces as
// a confusing 404/500.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { lib } = vi.hoisted(() => ({
  lib: { deleteReferenceAsset: vi.fn(async () => true) },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
}));

vi.mock('@/lib/referenceAssets', () => ({
  deleteReferenceAsset: lib.deleteReferenceAsset,
}));

import { DELETE } from './route';

const req = {} as unknown as NextRequest;

beforeEach(() => vi.clearAllMocks());

describe('references/[id] UUID guard', () => {
  it('DELETE 400s on a non-UUID id before any DB call', async () => {
    const res = await DELETE(req, { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(res.status).toBe(400);
    expect(lib.deleteReferenceAsset).not.toHaveBeenCalled();
  });

  it('DELETE lets a valid UUID through to the DB layer', async () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const res = await DELETE(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect(lib.deleteReferenceAsset).toHaveBeenCalledWith(id);
  });
});
