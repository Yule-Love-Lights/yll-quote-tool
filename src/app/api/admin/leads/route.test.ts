// Tests for GET /api/admin/leads — the operator-facing list behind /admin/leads
// (website lead-capture visibility + GHL-outage recovery). Strict requireAdmin()
// like the rest of /api/admin/*. Covers the admin gate, the 503 config guard, and
// the status-filter query shaping (default 'stuck' = pending+deferred+failed).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const { requireAdminMock, sbRef } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  sbRef: { current: null as unknown },
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireAdmin: requireAdminMock }));
vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient: () => sbRef.current }));

import { GET } from './route';

const adminAuth = { operator: { id: 'admin1', email: 'a@x.com', role: 'admin' } };
const denied401 = { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };

function makeSb(rows: Array<Record<string, unknown>>) {
  const filters: { in?: [string, unknown]; eq?: [string, unknown] } = {};
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    order: () => builder,
    limit: () => builder,
    in: (c: string, v: unknown) => {
      filters.in = [c, v];
      return builder;
    },
    eq: (c: string, v: unknown) => {
      filters.eq = [c, v];
      return builder;
    },
    then: (resolve: (v: unknown) => void) => resolve({ data: rows, error: null }),
  });
  return { client: builder, filters };
}

function req(status?: string): NextRequest {
  const url = status
    ? `http://localhost/api/admin/leads?status=${status}`
    : 'http://localhost/api/admin/leads';
  return { nextUrl: new URL(url) } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue(adminAuth);
  sbRef.current = makeSb([]).client;
});

describe('GET /api/admin/leads — admin gate', () => {
  it('returns the gate response when unauthorized', async () => {
    requireAdminMock.mockResolvedValueOnce(denied401);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it('503s when the Supabase service role is not configured', async () => {
    sbRef.current = null;
    const res = await GET(req());
    expect(res.status).toBe(503);
  });
});

describe('GET /api/admin/leads — status filter', () => {
  it('defaults to the actionable "stuck" set (pending+deferred+failed)', async () => {
    const sb = makeSb([{ id: 'l1', sync_status: 'pending' }]);
    sbRef.current = sb.client;
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(sb.filters.in).toEqual(['sync_status', ['pending', 'deferred', 'failed']]);
    const body = await res.json();
    expect(body.leads).toHaveLength(1);
  });

  it('filters to a single explicit status', async () => {
    const sb = makeSb([]);
    sbRef.current = sb.client;
    await GET(req('synced'));
    expect(sb.filters.eq).toEqual(['sync_status', 'synced']);
    expect(sb.filters.in).toBeUndefined();
  });

  it('applies no status filter for status=all', async () => {
    const sb = makeSb([]);
    sbRef.current = sb.client;
    await GET(req('all'));
    expect(sb.filters.in).toBeUndefined();
    expect(sb.filters.eq).toBeUndefined();
  });
});
