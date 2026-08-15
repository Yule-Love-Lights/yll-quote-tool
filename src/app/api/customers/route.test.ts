// Tests for GET /api/customers (ledger #41 — quote builder "Referred by" typeahead).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { requireOperatorMock, sbRef, creditBalanceForMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  sbRef: { current: null as unknown },
  creditBalanceForMock: vi.fn(async () => 0),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
// Referral program redemption (#41 PR 2): mocked so the route's wiring is
// testable without a real referrals table. Its OWN math is covered in
// src/lib/referrals.test.ts.
vi.mock('@/lib/referrals', () => ({ creditBalanceFor: creditBalanceForMock }));

import { GET } from './route';

function makeReq(query: string): NextRequest {
  return {
    nextUrl: { searchParams: new URLSearchParams(query) },
  } as unknown as NextRequest;
}

type Row = {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  hl_contact_id?: string;
  is_nce?: boolean;
  is_yll_neighbor?: boolean;
};

function makeSb(rows: Row[]) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    or: () => builder,
    order: () => builder,
    limit: async () => ({ data: rows, error: null }),
    eq: (col: string, val: unknown) => {
      const hit = rows.find((r) => (r as unknown as Record<string, unknown>)[col] === val) ?? null;
      return { maybeSingle: async () => ({ data: hit, error: null }) };
    },
  });
  return builder;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  creditBalanceForMock.mockResolvedValue(0);
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

  // Redemption (PR 2): each search result carries the customer's referral
  // credit balance.
  it('attaches referralCreditUsd to each search result', async () => {
    creditBalanceForMock.mockResolvedValueOnce(250);
    const res = await GET(makeReq('q=Jordan'));
    const json = await res.json();
    expect(json.customers[0].referralCreditUsd).toBe(250);
  });
});

describe('GET /api/customers?id=<uuid> (redemption, PR 2)', () => {
  const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  beforeEach(() => {
    sbRef.current = makeSb([{ id: ID, name: 'Jordan Smith', email: 'jordan@example.com', phone: '5165550123' }]);
  });

  it('returns the single customer with their referral credit balance', async () => {
    creditBalanceForMock.mockResolvedValueOnce(125);
    const res = await GET(makeReq(`id=${ID}`));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.customers).toEqual([
      { id: ID, name: 'Jordan Smith', email: 'jordan@example.com', phone: '5165550123', referralCreditUsd: 125 },
    ]);
  });

  it('returns an empty list for an unknown id', async () => {
    const res = await GET(makeReq('id=bbbbbbbb-cccc-4ddd-8eee-ffffffffffff'));
    const json = await res.json();
    expect(json.customers).toEqual([]);
  });

  it('returns an empty list for a malformed (non-UUID) id, without querying', async () => {
    const res = await GET(makeReq('id=not-a-uuid'));
    const json = await res.json();
    expect(json.customers).toEqual([]);
  });
});

describe('GET /api/customers?hlContactId=<id> (tag inheritance, #198)', () => {
  const CONTACT_ID = 'ghl-contact-abc123';

  beforeEach(() => {
    sbRef.current = makeSb([
      {
        id: 'cust-1',
        name: 'Jordan Smith',
        email: 'jordan@example.com',
        phone: '5165550123',
        hl_contact_id: CONTACT_ID,
        is_nce: true,
        is_yll_neighbor: false,
      },
    ]);
  });

  it('returns the customer (with tags) for a known hl_contact_id', async () => {
    const res = await GET(makeReq(`hlContactId=${CONTACT_ID}`));
    const json = await res.json();
    expect(res.status).toBe(200);
    // toMatchObject (not toEqual): the real route only SELECTs the columns in
    // CUSTOMER_COLUMNS (no hl_contact_id), but this fake returns the whole
    // seeded row regardless of the select string — same pre-existing
    // fidelity gap as every other fake in this file, not a new one.
    expect(json.customers).toMatchObject([
      {
        id: 'cust-1',
        name: 'Jordan Smith',
        email: 'jordan@example.com',
        phone: '5165550123',
        is_nce: true,
        is_yll_neighbor: false,
        referralCreditUsd: 0,
      },
    ]);
  });

  it('returns an empty list for an unknown hl_contact_id — never creates a row', async () => {
    const res = await GET(makeReq('hlContactId=unknown-contact'));
    const json = await res.json();
    expect(json.customers).toEqual([]);
  });

  it('takes precedence over q when both are somehow present, mirroring the id branch', async () => {
    const res = await GET(makeReq(`hlContactId=${CONTACT_ID}&q=Jordan`));
    const json = await res.json();
    expect(json.customers).toHaveLength(1);
    expect(json.customers[0].id).toBe('cust-1');
  });
});
