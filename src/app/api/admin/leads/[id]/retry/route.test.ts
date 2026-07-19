// Tests for POST /api/admin/leads/[id]/retry — an operator's manual re-drive of a
// single stuck website-lead row from /admin/leads. Strict requireAdmin(). The
// retry orchestration (retryOneLead) is unit-tested in leadRetry.test.ts and
// mocked here; this covers the gate, the 503/404 guards, the not-retriable
// (spam/synced) guards, and delegation.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const { requireAdminMock, retryOneLeadMock, sbRef } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  retryOneLeadMock: vi.fn(),
  sbRef: { current: null as unknown },
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireAdmin: requireAdminMock }));
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));
vi.mock('@/lib/leads/leadRetry', () => ({ retryOneLead: retryOneLeadMock }));

import { POST } from './route';

const adminAuth = { operator: { id: 'admin1', email: 'a@x.com', role: 'admin' } };
const denied401 = { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
const VALID_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeSb(row: Record<string, unknown> | null) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: row, error: null }),
  });
  return builder;
}

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue(adminAuth);
  retryOneLeadMock.mockResolvedValue('synced');
  sbRef.current = makeSb({ id: VALID_ID, sync_status: 'pending' });
});

describe('POST /api/admin/leads/[id]/retry — guards', () => {
  it('returns the gate response and never retries when unauthorized', async () => {
    requireAdminMock.mockResolvedValueOnce(denied401);
    const res = await POST({} as NextRequest, ctx(VALID_ID));
    expect(res.status).toBe(401);
    expect(retryOneLeadMock).not.toHaveBeenCalled();
  });

  it('503s when the Supabase service role is not configured', async () => {
    sbRef.current = null;
    const res = await POST({} as NextRequest, ctx(VALID_ID));
    expect(res.status).toBe(503);
    expect(retryOneLeadMock).not.toHaveBeenCalled();
  });

  it('404s for a malformed (non-UUID) id', async () => {
    const res = await POST({} as NextRequest, ctx('not-a-uuid'));
    expect(res.status).toBe(404);
    expect(retryOneLeadMock).not.toHaveBeenCalled();
  });

  it('404s when no lead row exists for the id', async () => {
    sbRef.current = makeSb(null);
    const res = await POST({} as NextRequest, ctx(VALID_ID));
    expect(res.status).toBe(404);
    expect(retryOneLeadMock).not.toHaveBeenCalled();
  });

  it('400s a spam row (never a retry target)', async () => {
    sbRef.current = makeSb({ id: VALID_ID, sync_status: 'spam' });
    const res = await POST({} as NextRequest, ctx(VALID_ID));
    expect(res.status).toBe(400);
    expect(retryOneLeadMock).not.toHaveBeenCalled();
  });

  it('400s an already-synced row', async () => {
    sbRef.current = makeSb({ id: VALID_ID, sync_status: 'synced' });
    const res = await POST({} as NextRequest, ctx(VALID_ID));
    expect(res.status).toBe(400);
    expect(retryOneLeadMock).not.toHaveBeenCalled();
  });

  it("400s a 'partial' row and NEVER retries it — a partial has no SMS consent, so re-driving it would enrol a non-consenter in the drips (quote-forms-partial-save)", async () => {
    sbRef.current = makeSb({ id: VALID_ID, sync_status: 'partial' });
    const res = await POST({} as NextRequest, ctx(VALID_ID));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/consent/i);
    expect(retryOneLeadMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/leads/[id]/retry — success', () => {
  it('re-drives a stuck row and returns the outcome', async () => {
    retryOneLeadMock.mockResolvedValue('synced');
    const res = await POST({} as NextRequest, ctx(VALID_ID));
    expect(res.status).toBe(200);
    expect(retryOneLeadMock).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, id: VALID_ID, outcome: 'synced' });
  });

  it('allows retrying a failed (terminal) row — the operator override', async () => {
    sbRef.current = makeSb({ id: VALID_ID, sync_status: 'failed' });
    retryOneLeadMock.mockResolvedValue('synced');
    const res = await POST({} as NextRequest, ctx(VALID_ID));
    expect(res.status).toBe(200);
    expect(retryOneLeadMock).toHaveBeenCalledTimes(1);
  });
});
