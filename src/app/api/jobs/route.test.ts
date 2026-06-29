// Tests for the operator gate on the #83 billing jobs list (GET /api/jobs).
// Operator-only — it returns customer PII. The auth gate, Supabase config, and
// the data layer are mocked, mirroring /api/quotes/route.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

const { listJobsForAdmin, requireOperatorMock } = vi.hoisted(() => ({
  listJobsForAdmin: vi.fn(async () => [{ id: 'j1', jobNumber: 1001 }]),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/jobs', () => ({ listJobsForAdmin }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));

import { GET } from './route';

const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null); // default: authorized (or dormant)
});

describe('GET /api/jobs — operator billing list', () => {
  it('returns the gate response (401) when the operator gate denies — never touches the data layer', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await GET();
    expect(res.status).toBe(401);
    expect(listJobsForAdmin).not.toHaveBeenCalled();
  });

  it('returns the jobs when authorized', async () => {
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.jobs).toEqual([{ id: 'j1', jobNumber: 1001 }]);
    expect(listJobsForAdmin).toHaveBeenCalledOnce();
  });
});
