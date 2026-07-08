// Tests for POST /api/customers/[customerId]/rebook (rebook Part C).
//
// Verifies:
//   1. Bad UUID customerId → 400.
//   2. No approved source quote → 404 with code 'no-source'.
//   3. Success → 200 with { ok: true, quoteId, designId }.
//   4. Operator gate is enforced.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { rebookMock, requireOperatorMock, getOperatorMock } = vi.hoisted(() => ({
  rebookMock: vi.fn<() => Promise<{ quoteId: string; designId: string | null } | null>>(),
  requireOperatorMock: vi.fn(async (): Promise<NextResponse | null> => null),
  getOperatorMock: vi.fn(async (): Promise<{ id: string } | null> => null),
}));

vi.mock('@/lib/rebook', () => ({
  rebookLastSeason: rebookMock,
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
}));

import { POST } from './route';

const VALID_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

function makeReq(body?: unknown): NextRequest {
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  } as unknown as NextRequest;
}

function makeParams(customerId: string) {
  return { params: Promise.resolve({ customerId }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null); // default: authorized / gate dormant
  getOperatorMock.mockResolvedValue(null); // default: no session / gate dormant
  rebookMock.mockResolvedValue({ quoteId: 'new-quote', designId: 'new-design' });
});

describe('POST /api/customers/[customerId]/rebook — validation', () => {
  it('400 for a non-UUID customerId', async () => {
    const res = await POST(makeReq(), makeParams('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(rebookMock).not.toHaveBeenCalled();
  });

  it('400 for an empty customerId', async () => {
    const res = await POST(makeReq(), makeParams(''));
    expect(res.status).toBe(400);
    expect(rebookMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/customers/[customerId]/rebook — operator gate', () => {
  it('returns the gate response and never calls rebookLastSeason when denied', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(makeReq(), makeParams(VALID_UUID));
    expect(res.status).toBe(401);
    expect(rebookMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/customers/[customerId]/rebook — no source', () => {
  it('404 with code no-source when rebookLastSeason returns null', async () => {
    rebookMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json).toMatchObject({ code: 'no-source' });
    expect(rebookMock).toHaveBeenCalledWith(VALID_UUID, undefined, null);
  });
});

describe('POST /api/customers/[customerId]/rebook — success', () => {
  it('200 with ok + quoteId + designId on success', async () => {
    const res = await POST(makeReq(), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, quoteId: 'new-quote', designId: 'new-design' });
    expect(rebookMock).toHaveBeenCalledWith(VALID_UUID, undefined, null);
  });

  it('passes a valid propertyId from the body to rebookLastSeason', async () => {
    const propId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const res = await POST(makeReq({ propertyId: propId }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(rebookMock).toHaveBeenCalledWith(VALID_UUID, propId, null);
  });

  it('ignores a malformed propertyId in the body (non-UUID)', async () => {
    const res = await POST(makeReq({ propertyId: 'bad-id' }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    // Non-UUID property id silently dropped; rebook called without scope.
    expect(rebookMock).toHaveBeenCalledWith(VALID_UUID, undefined, null);
  });

  it('handles a missing body gracefully (no body → no property scope)', async () => {
    const res = await POST(makeReq(undefined), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(rebookMock).toHaveBeenCalledWith(VALID_UUID, undefined, null);
  });

  it('forwards the authenticated operator id (#90 actor audit trail) to rebookLastSeason', async () => {
    getOperatorMock.mockResolvedValueOnce({ id: 'operator-123' });
    const res = await POST(makeReq(), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(rebookMock).toHaveBeenCalledWith(VALID_UUID, undefined, 'operator-123');
  });
});
