// Tests for POST /api/admin/customers/backfill (rebook Part B).
//
// Verifies:
//   1. Admin gate is enforced (audit W2-020 — matches the /api/admin/* namespace
//      and the sibling admin/users routes, which are strict requireAdmin(), not
//      the dormancy-bypassable requireOperator()) — a denied gate response is
//      returned and backfillCustomersFromQuotes is never called.
//   2. 503 when the service role is not configured.
//   3. 200 with the backfill summary { scanned, linked, skipped } on success.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

const { backfillMock, requireAdminMock, serviceConfiguredRef } = vi.hoisted(() => ({
  backfillMock: vi.fn(async () => ({ scanned: 10, linked: 8, skipped: 2 })),
  requireAdminMock: vi.fn(),
  serviceConfiguredRef: { current: true },
}));

vi.mock('@/lib/customers', () => ({
  backfillCustomersFromQuotes: backfillMock,
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireAdmin: requireAdminMock,
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => serviceConfiguredRef.current,
}));

import { POST } from './route';

const adminAuth = { operator: { id: 'admin1', email: 'a@x.com', role: 'admin' } };
const forbidden403 = { response: NextResponse.json({ error: 'Admin access required' }, { status: 403 }) };
const denied401 = { response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };

beforeEach(() => {
  vi.clearAllMocks();
  serviceConfiguredRef.current = true;
  requireAdminMock.mockResolvedValue(adminAuth); // default: authorized admin
});

describe('POST /api/admin/customers/backfill — admin gate (W2-020)', () => {
  it('returns the gate response and never calls backfill when unauthenticated', async () => {
    requireAdminMock.mockResolvedValueOnce(denied401);
    const res = await POST();
    expect(res.status).toBe(401);
    expect(backfillMock).not.toHaveBeenCalled();
  });

  it('returns the gate response and never calls backfill for a non-admin operator', async () => {
    requireAdminMock.mockResolvedValueOnce(forbidden403);
    const res = await POST();
    expect(res.status).toBe(403);
    expect(backfillMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/customers/backfill — 503 guard', () => {
  it('returns 503 when the service role is not configured', async () => {
    serviceConfiguredRef.current = false;
    const res = await POST();
    expect(res.status).toBe(503);
    expect(backfillMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/customers/backfill — success', () => {
  it('returns 200 with the backfill summary when authorized and Supabase is configured', async () => {
    const res = await POST();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ scanned: 10, linked: 8, skipped: 2 });
    expect(backfillMock).toHaveBeenCalledOnce();
  });
});
