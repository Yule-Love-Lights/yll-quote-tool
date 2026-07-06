// CRITICAL #2 (audit AUDIT-2026-06-26): GET /api/integrations/highlevel/contacts
// enumerates CRM PII and was unauthenticated. The operator gate must reject the
// request BEFORE any CRM call when it denies. Auth + CRM + rate-limit mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { searchContacts, requireOperatorMock } = vi.hoisted(() => ({
  searchContacts: vi.fn(async () => [{ id: 'c1', name: 'Jane' }]),
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/integrations/highlevel', () => ({
  searchContacts,
  isHighLevelConfigured: () => true,
  HighLevelError: class HighLevelError extends Error {},
}));
vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));

import { GET } from './route';

const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
function makeReq(url: string): NextRequest {
  return { url, headers: { get: () => null } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
});

describe('GET /api/integrations/highlevel/contacts — operator gate (CRITICAL #2)', () => {
  it('returns the gate 401 and never touches the CRM when the gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await GET(makeReq('https://x/api/integrations/highlevel/contacts?q=jane'));
    expect(res.status).toBe(401);
    expect(searchContacts).not.toHaveBeenCalled();
  });

  it('queries the CRM when authorized', async () => {
    const res = await GET(makeReq('https://x/api/integrations/highlevel/contacts?q=jane'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(searchContacts).toHaveBeenCalledOnce();
    expect(json.contacts).toHaveLength(1);
  });
});

describe('GET /api/integrations/highlevel/contacts — limit NaN guard (#110 W6-015)', () => {
  it('falls back to the default limit when ?limit= is non-numeric', async () => {
    await GET(makeReq('https://x/api/integrations/highlevel/contacts?q=jane&limit=notanumber'));
    expect(searchContacts).toHaveBeenCalledWith('jane', 20);
  });

  it('still clamps a valid numeric limit', async () => {
    await GET(makeReq('https://x/api/integrations/highlevel/contacts?q=jane&limit=999'));
    expect(searchContacts).toHaveBeenCalledWith('jane', 50);
  });
});
