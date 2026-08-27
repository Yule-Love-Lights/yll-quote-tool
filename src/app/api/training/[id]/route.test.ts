// Audit fix (id-route-uuid-guards): a non-UUID [id] must be rejected with 400
// BEFORE the DB layer runs — otherwise Postgres raises 22P02 and it surfaces as
// a confusing 404/500. The lib calls are mocked so we can assert they're never
// invoked for a bad id.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { lib } = vi.hoisted(() => ({
  lib: {
    getTrainingHouse: vi.fn(async () => ({ id: 'x' })),
    deleteTrainingHouse: vi.fn(async () => true),
  },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
}));

vi.mock('@/lib/training', () => ({
  getTrainingHouse: lib.getTrainingHouse,
  deleteTrainingHouse: lib.deleteTrainingHouse,
}));

// ledger #347: requireOperator is now engaged by default — stub it authorized
// like the other route.ts test suites do; this suite is about the UUID guard.
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: vi.fn(async () => null) }));

import { GET, DELETE } from './route';

const req = {} as unknown as NextRequest;

beforeEach(() => vi.clearAllMocks());

describe('training/[id] UUID guard', () => {
  it('GET 400s on a non-UUID id before any DB call', async () => {
    const res = await GET(req, { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(res.status).toBe(400);
    expect(lib.getTrainingHouse).not.toHaveBeenCalled();
  });

  it('DELETE 400s on a non-UUID id before any DB call', async () => {
    const res = await DELETE(req, { params: Promise.resolve({ id: '123' }) });
    expect(res.status).toBe(400);
    expect(lib.deleteTrainingHouse).not.toHaveBeenCalled();
  });

  it('GET lets a valid UUID through to the DB layer', async () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const res = await GET(req, { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect(lib.getTrainingHouse).toHaveBeenCalledWith(id);
  });
});
