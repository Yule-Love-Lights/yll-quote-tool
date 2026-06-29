// Tests for GET /api/jobs/[id] (#83 billing job detail). Operator-only; the auth
// gate + data layer are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { getJobDetail, requireOperatorMock } = vi.hoisted(() => ({
  getJobDetail: vi.fn(),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/jobs', () => ({ getJobDetail }));

import { GET } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = {} as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getJobDetail.mockResolvedValue({ job: { id: ID, status: 'requires_invoicing' }, invoice: null });
});

describe('GET /api/jobs/[id]', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await GET(req, ctx());
    expect(res.status).toBe(401);
    expect(getJobDetail).not.toHaveBeenCalled();
  });

  it('400s on an invalid job id', async () => {
    const res = await GET(req, ctx('nope'));
    expect(res.status).toBe(400);
  });

  it('404s when the job is missing', async () => {
    getJobDetail.mockResolvedValueOnce(null);
    const res = await GET(req, ctx());
    expect(res.status).toBe(404);
  });

  it('returns the detail when authorized', async () => {
    const res = await GET(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.job).toMatchObject({ id: ID });
  });
});
