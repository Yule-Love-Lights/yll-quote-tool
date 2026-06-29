// Tests for the operator gate + bulk-delete guard on /api/quotes (ledger #81 +
// audit fix g29-route). The PII list (GET) and the full-PII wipe (DELETE) are
// operator-only; the wipe ALSO requires an explicit confirmation header — being
// an authenticated operator alone must not one-shot the whole table. The auth
// gate, Supabase, and the data layer are mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { deleteAllQuotes, deleteTestQuotes, requireOperatorMock } = vi.hoisted(() => ({
  deleteAllQuotes: vi.fn(async () => 3),
  deleteTestQuotes: vi.fn(async () => 2),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseConfigured: () => true,
  isSupabaseServiceConfigured: () => true,
}));

vi.mock('@/lib/quotes', () => ({
  deleteAllQuotes,
  deleteTestQuotes,
  listQuotes: vi.fn(async () => []),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
}));

import { DELETE, GET } from './route';

const CONFIRM = 'DELETE ALL QUOTES';
const TEST_CONFIRM = 'DELETE TEST QUOTES';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

function makeReq(headers: Record<string, string>, scope?: string): NextRequest {
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    nextUrl: { searchParams: new URLSearchParams(scope ? { scope } : {}) },
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

describe('DELETE /api/quotes?scope=test — scoped test-data wipe (#93)', () => {
  it('deletes ONLY test quotes with the test confirmation phrase', async () => {
    const res = await DELETE(makeReq({ 'x-confirm-delete-all': TEST_CONFIRM }, 'test'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ deleted: 2, scope: 'test' });
    expect(deleteTestQuotes).toHaveBeenCalledOnce();
    expect(deleteAllQuotes).not.toHaveBeenCalled();
  });

  it('428s when the all-quotes phrase is used for the test scope (phrases are distinct)', async () => {
    const res = await DELETE(makeReq({ 'x-confirm-delete-all': CONFIRM }, 'test'));
    expect(res.status).toBe(428);
    expect(deleteTestQuotes).not.toHaveBeenCalled();
    expect(deleteAllQuotes).not.toHaveBeenCalled();
  });

  it('does NOT delete test quotes when the all-scope path is taken with the test phrase', async () => {
    // The full wipe must require its OWN phrase — the test phrase can't trigger it.
    const res = await DELETE(makeReq({ 'x-confirm-delete-all': TEST_CONFIRM }));
    expect(res.status).toBe(428);
    expect(deleteAllQuotes).not.toHaveBeenCalled();
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
