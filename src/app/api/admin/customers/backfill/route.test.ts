// Tests for POST /api/admin/customers/backfill (rebook Part B).
//
// Verifies:
//   1. Operator gate is enforced — a denied gate response is returned and
//      backfillCustomersFromQuotes is never called.
//   2. 503 when the service role is not configured.
//   3. 200 with the backfill summary { scanned, linked, skipped } on success.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse } from 'next/server';

const { backfillMock, requireOperatorMock, serviceConfiguredRef } = vi.hoisted(() => ({
  backfillMock: vi.fn(async () => ({ scanned: 10, linked: 8, skipped: 2 })),
  requireOperatorMock: vi.fn(async (): Promise<NextResponse | null> => null),
  serviceConfiguredRef: { current: true },
}));

vi.mock('@/lib/customers', () => ({
  backfillCustomersFromQuotes: backfillMock,
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => serviceConfiguredRef.current,
}));

import { POST } from './route';

const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

beforeEach(() => {
  vi.clearAllMocks();
  serviceConfiguredRef.current = true;
  requireOperatorMock.mockResolvedValue(null); // default: authorized / gate dormant
});

describe('POST /api/admin/customers/backfill — operator gate', () => {
  it('returns the gate response and never calls backfill when denied', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST();
    expect(res.status).toBe(401);
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
