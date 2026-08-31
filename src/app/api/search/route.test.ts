// Tests for GET /api/search (the operator header search box).
//
// The ranking and matching logic is tested directly in
// src/lib/search/globalSearch.test.ts. What is tested here is the edge: the
// operator gate, the unconfigured case, the query passthrough, and that a
// thrown search reports a failure rather than an empty result set.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireOperatorMock, configuredMock, clientMock, globalSearchMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  configuredMock: vi.fn(() => true),
  clientMock: vi.fn(() => ({}) as unknown),
  globalSearchMock: vi.fn(async () => ({
    customers: [],
    quotes: [],
    jobs: [],
    invoices: [],
  })),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: configuredMock,
  getSupabaseServiceClient: clientMock,
}));
vi.mock('@/lib/search/globalSearch', async () => {
  const actual = await vi.importActual<typeof import('@/lib/search/globalSearch')>(
    '@/lib/search/globalSearch',
  );
  return { ...actual, globalSearch: globalSearchMock };
});

import { GET } from './route';

function makeReq(query: string): NextRequest {
  return { nextUrl: { searchParams: new URLSearchParams(query) } } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  configuredMock.mockReturnValue(true);
  clientMock.mockReturnValue({} as unknown);
  globalSearchMock.mockResolvedValue({ customers: [], quotes: [], jobs: [], invoices: [] });
});

describe('GET /api/search', () => {
  it('refuses a caller with no operator session', async () => {
    const denial = new Response('no', { status: 401 });
    requireOperatorMock.mockResolvedValue(denial);
    const res = await GET(makeReq('q=Kristie'));
    expect(res).toBe(denial);
    // The gate runs BEFORE any database work, so a signed-out caller cannot
    // reach customer records at all.
    expect(globalSearchMock).not.toHaveBeenCalled();
  });

  it('answers 503 when Supabase is not configured', async () => {
    configuredMock.mockReturnValue(false);
    const res = await GET(makeReq('q=Kristie'));
    expect(res.status).toBe(503);
    expect(globalSearchMock).not.toHaveBeenCalled();
  });

  it('passes the raw query through to the search engine', async () => {
    const res = await GET(makeReq('q=Kristie'));
    expect(res.status).toBe(200);
    expect(globalSearchMock).toHaveBeenCalledWith(expect.anything(), 'Kristie');
  });

  it('treats a missing q as an empty query rather than crashing', async () => {
    const res = await GET(makeReq(''));
    expect(res.status).toBe(200);
    expect(globalSearchMock).toHaveBeenCalledWith(expect.anything(), '');
  });

  it('returns the four groups the box renders', async () => {
    globalSearchMock.mockResolvedValue({
      customers: [{ key: 'customer:c1' }],
      quotes: [],
      jobs: [],
      invoices: [],
    } as never);
    const res = await GET(makeReq('q=Kristie'));
    const json = await res.json();
    expect(json.results.customers).toHaveLength(1);
    expect(json.results).toHaveProperty('quotes');
    expect(json.results).toHaveProperty('jobs');
    expect(json.results).toHaveProperty('invoices');
  });

  it('reports a failed search as 500, never as "no matches"', async () => {
    globalSearchMock.mockRejectedValue(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await GET(makeReq('q=Kristie'));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe('Search failed');
    spy.mockRestore();
  });
});
