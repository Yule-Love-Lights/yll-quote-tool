// Tests for GET /api/customers (ledger #41 — quote builder "Referred by" typeahead).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireOperatorMock, sbRef } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  sbRef: { current: null as unknown },
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

import { GET } from './route';

function makeReq(query: string): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(query) },
  } as unknown as NextRequest;
}

function makeSb(rows: Array<{ id: string; name: string | null; email: string | null; phone: string | null }>) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    or: () => builder,
    order: () => builder,
    limit: async () => ({ data: rows, error: null }),
  });
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  sbRef.current = makeSb([{ id: 'c1', name: 'Jordan Smith', email: 'jordan@example.com', phone: '5165550123' }]);
});

describe('GET /api/customers', () => {
  it('returns matches for a real query', async () => {
    const res = await GET(makeReq('q=Jordan'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.customers).toHaveLength(1);
    expect(json.customers[0].name).toBe('Jordan Smith');
  });

  it('returns an empty list for a too-short query without hitting the DB', async () => {
    const res = await GET(makeReq('q=j'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.customers).toEqual([]);
  });

  it('returns an empty list for a missing query', async () => {
    const res = await GET(makeReq(''));
    const json = await res.json();
    expect(json.customers).toEqual([]);
  });

  it('refuses a query containing PostgREST .or() filter-injection characters', async () => {
    const res = await GET(makeReq('q=' + encodeURIComponent('a,b(c)')));
    const json = await res.json();
    expect(json.customers).toEqual([]);
  });
});
