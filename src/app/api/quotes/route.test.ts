// Tests for the operator gate + bulk-delete guard on /api/quotes (ledger #81 +
// audit fix g29-route). The PII list (GET) and the full-PII wipe (DELETE) are
// operator-only; the wipe ALSO requires an explicit confirmation header — being
// an authenticated operator alone must not one-shot the whole table. The auth
// gate, Supabase, and the data layer are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { deleteAllQuotes, requireOperatorMock } = vi.hoisted(() => ({
  deleteAllQuotes: vi.fn(async () => 3),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  isSupabaseServiceConfigured: () => true,
}));

vi.mock('@/lib/quotes', () => ({
  deleteAllQuotes,
  listQuotes: vi.fn(async () => []),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
}));

import { DELETE, GET } from './route';

const CONFIRM = 'DELETE ALL QUOTES';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

function makeReq(headers: Record<string, string>): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null); // default: authorized (or dormant)
});

describe('DELETE /api/quotes — operator gate + bulk-wipe confirmation', () => {
  it('returns the gate response (401) when the operator gate denies — never touches the data layer', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await DELETE(makeReq({ 'x-confirm-delete-all': CONFIRM }));
    expect(res.status).toBe(401);
    expect(deleteAllQuotes).not.toHaveBeenCalled();
  });

  it('428s when authorized but the confirmation header is missing', async () => {
    const res = await DELETE(makeReq({}));
    expect(res.status).toBe(428);
    expect(deleteAllQuotes).not.toHaveBeenCalled();
  });

  it('428s when the confirmation header value is wrong', async () => {
    const res = await DELETE(makeReq({ 'x-confirm-delete-all': 'yes' }));
    expect(res.status).toBe(428);
    expect(deleteAllQuotes).not.toHaveBeenCalled();
  });

  it('deletes only when authorized AND the exact confirmation phrase is present', async () => {
    const res = await DELETE(makeReq({ 'x-confirm-delete-all': CONFIRM }));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.deleted).toBe(3);
    expect(deleteAllQuotes).toHaveBeenCalledOnce();
  });
});

describe('GET /api/quotes — operator gate on the PII list', () => {
  it('returns the gate response (401) when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns the list when authorized', async () => {
    const res = await GET();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.items).toEqual([]);
  });
});
