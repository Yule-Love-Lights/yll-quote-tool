// Tests for POST /api/admin/jobber-import (ledger #72 scaffold).
//
// Verifies:
//   1. Admin gate is enforced (mirrors the /admin/customers/backfill route —
//      strict requireAdmin(), never dormancy-bypassed) — a denied gate
//      response is returned and nothing downstream is called.
//   2. 503 when the service role is not configured.
//   3. Request-body validation (csv/map required).
//   4. mode: 'dry-run' (default) returns the plan and never calls commit.
//   5. mode: 'commit' calls commit and returns { plan, result }.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

const { planMock, commitMock, requireAdminMock, serviceConfiguredRef } = vi.hoisted(() => ({
  planMock: vi.fn(() => ({
    totalRows: 1,
    isTest: true,
    counts: { createNew: 1, matchExisting: 0, skip: 0 },
    rows: [],
    errors: [],
  })),
  commitMock: vi.fn(async () => ({ attempted: 1, created: 1, skippedExisting: 0, failed: 0, errors: [] })),
  requireAdminMock: vi.fn(),
  serviceConfiguredRef: { current: true },
}));

vi.mock('@/lib/import/jobberImport', () => ({
  parseJobberCsv: (csv: string) => [{ raw: csv }],
  planJobberImport: planMock,
  commitJobberImport: commitMock,
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

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/admin/jobber-import', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

const validMap = {
  sourceId: null,
  customerName: 'Customer Name',
  customerEmail: null,
  customerPhone: null,
  propertyAddress: null,
  total: 'Total',
  serviceType: null,
  status: null,
  customerApprovedAt: null,
  quoteSentAt: null,
  depositPaidAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  serviceConfiguredRef.current = true;
  requireAdminMock.mockResolvedValue(adminAuth);
});

describe('POST /api/admin/jobber-import — admin gate', () => {
  it('returns the gate response and never plans/commits when unauthenticated', async () => {
    requireAdminMock.mockResolvedValueOnce(denied401);
    const res = await POST(makeRequest({ csv: 'a,b\n1,2', map: validMap }));
    expect(res.status).toBe(401);
    expect(planMock).not.toHaveBeenCalled();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('returns the gate response for a non-admin operator', async () => {
    requireAdminMock.mockResolvedValueOnce(forbidden403);
    const res = await POST(makeRequest({ csv: 'a,b\n1,2', map: validMap }));
    expect(res.status).toBe(403);
    expect(planMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/jobber-import — 503 guard', () => {
  it('returns 503 when the service role is not configured', async () => {
    serviceConfiguredRef.current = false;
    const res = await POST(makeRequest({ csv: 'a,b\n1,2', map: validMap }));
    expect(res.status).toBe(503);
    expect(planMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/jobber-import — body validation', () => {
  it('400s when csv is missing/blank', async () => {
    const res = await POST(makeRequest({ csv: '  ', map: validMap }));
    expect(res.status).toBe(400);
    expect(planMock).not.toHaveBeenCalled();
  });

  it('400s when map is missing', async () => {
    const res = await POST(makeRequest({ csv: 'a,b\n1,2' }));
    expect(res.status).toBe(400);
    expect(planMock).not.toHaveBeenCalled();
  });

  it('400s on invalid JSON', async () => {
    const req = new NextRequest('http://localhost/api/admin/jobber-import', {
      method: 'POST',
      body: '{not json',
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/admin/jobber-import — dry-run (default)', () => {
  it('returns the plan and never calls commit', async () => {
    const res = await POST(makeRequest({ csv: 'a,b\n1,2', map: validMap }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.mode).toBe('dry-run');
    expect(json.plan.counts).toEqual({ createNew: 1, matchExisting: 0, skip: 0 });
    expect(planMock).toHaveBeenCalledOnce();
    expect(commitMock).not.toHaveBeenCalled();
  });

  it('is the default when mode is omitted or unrecognized', async () => {
    const res = await POST(makeRequest({ csv: 'a,b\n1,2', map: validMap, mode: 'bogus' }));
    const json = await res.json();
    expect(json.mode).toBe('dry-run');
    expect(commitMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/jobber-import — commit', () => {
  it('calls commitJobberImport and returns { plan, result }', async () => {
    const res = await POST(makeRequest({ csv: 'a,b\n1,2', map: validMap, mode: 'commit' }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.mode).toBe('commit');
    expect(json.result).toEqual({ attempted: 1, created: 1, skippedExisting: 0, failed: 0, errors: [] });
    expect(commitMock).toHaveBeenCalledOnce();
  });
});
