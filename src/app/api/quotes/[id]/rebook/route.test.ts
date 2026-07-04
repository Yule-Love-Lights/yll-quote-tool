// Tests for POST /api/quotes/[id]/rebook (#116 — revive a dead quote).
//
// Verifies:
//   1. Bad / empty UUID id → 400 (rebookFromQuote never called).
//   2. Operator gate is enforced (denied → gate response, no rebook).
//   3. No matching quote → 404 with code 'no-source'.
//   4. Success → 200 with { ok: true, quoteId, designId }.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { rebookMock, requireOperatorMock } = vi.hoisted(() => ({
  rebookMock: vi.fn<() => Promise<{ quoteId: string; designId: string | null } | null>>(),
  requireOperatorMock: vi.fn(async (): Promise<NextResponse | null> => null),
}));

vi.mock('@/lib/rebook', () => ({
  rebookFromQuote: rebookMock,
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
}));

import { POST } from './route';

const VALID_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

function makeReq(): NextRequest {
  return {} as unknown as NextRequest;
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null); // default: authorized / gate dormant
  rebookMock.mockResolvedValue({ quoteId: 'new-quote', designId: 'new-design' });
});

describe('POST /api/quotes/[id]/rebook — validation', () => {
  it('400 for a non-UUID id', async () => {
    const res = await POST(makeReq(), makeParams('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(rebookMock).not.toHaveBeenCalled();
  });

  it('400 for an empty id', async () => {
    const res = await POST(makeReq(), makeParams(''));
    expect(res.status).toBe(400);
    expect(rebookMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/quotes/[id]/rebook — operator gate', () => {
  it('returns the gate response and never calls rebookFromQuote when denied', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(makeReq(), makeParams(VALID_UUID));
    expect(res.status).toBe(401);
    expect(rebookMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/quotes/[id]/rebook — no source', () => {
  it('404 with code no-source when rebookFromQuote returns null', async () => {
    rebookMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq(), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json).toMatchObject({ code: 'no-source' });
    expect(rebookMock).toHaveBeenCalledWith(VALID_UUID);
  });
});

describe('POST /api/quotes/[id]/rebook — success', () => {
  it('200 with ok + quoteId + designId on success', async () => {
    const res = await POST(makeReq(), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, quoteId: 'new-quote', designId: 'new-design' });
    expect(rebookMock).toHaveBeenCalledWith(VALID_UUID);
  });
});
