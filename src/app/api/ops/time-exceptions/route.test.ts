// Tests for GET /api/ops/time-exceptions. ADMIN-ONLY as of Naldo's 2026-08-29
// ruling (was operator-only from row 278): the queue got an admin-only UI in
// /admin/time-tracking, and the API gate now agrees with the page gate.
// Mirrors the requireAdmin test idiom in /api/admin/leads/route.test.ts.
// The gate is negative-controlled at write time: loosening it back to
// requireOperator fails exactly the operator-403 test, restored.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const { requireAdminMock, listTimeExceptionsMock, configuredRef } = vi.hoisted(() => ({
  requireAdminMock: vi.fn(),
  listTimeExceptionsMock: vi.fn(),
  configuredRef: { current: true },
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireAdmin: requireAdminMock }));
vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => configuredRef.current }));
vi.mock('@/lib/opsTimeExceptions', () => ({
  DEFAULT_STALE_SEGMENT_HOURS: 12,
  listTimeExceptions: listTimeExceptionsMock,
}));

import { GET } from './route';

const adminAuth = { operator: { id: 'admin1', email: 'a@x.com', role: 'admin', name: null } };

const req = (url = 'http://x/api/ops/time-exceptions') =>
  ({ nextUrl: new URL(url) }) as unknown as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  configuredRef.current = true;
  listTimeExceptionsMock.mockResolvedValue({ exceptions: [], errors: [] });
});

describe('GET /api/ops/time-exceptions — admin gate', () => {
  it('returns the queue for an admin', async () => {
    requireAdminMock.mockResolvedValue(adminAuth);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.count).toBe(0);
    expect(listTimeExceptionsMock).toHaveBeenCalled();
  });

  it('refuses a non-admin with the guard response and never queries', async () => {
    requireAdminMock.mockResolvedValue({
      response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }),
    });
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(listTimeExceptionsMock).not.toHaveBeenCalled();
  });

  it('refuses a signed-out caller with the guard response', async () => {
    requireAdminMock.mockResolvedValue({
      response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    });
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(listTimeExceptionsMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/ops/time-exceptions — existing behavior preserved', () => {
  it('503s when the service role is unconfigured', async () => {
    requireAdminMock.mockResolvedValue(adminAuth);
    configuredRef.current = false;
    const res = await GET(req());
    expect(res.status).toBe(503);
  });

  it('rejects a non-positive staleHours', async () => {
    requireAdminMock.mockResolvedValue(adminAuth);
    const res = await GET(req('http://x/api/ops/time-exceptions?staleHours=-2'));
    expect(res.status).toBe(400);
  });

  it('passes a valid staleHours override through', async () => {
    requireAdminMock.mockResolvedValue(adminAuth);
    const res = await GET(req('http://x/api/ops/time-exceptions?staleHours=6'));
    expect(res.status).toBe(200);
    expect(listTimeExceptionsMock).toHaveBeenCalledWith(expect.any(Date), 6);
  });
});
