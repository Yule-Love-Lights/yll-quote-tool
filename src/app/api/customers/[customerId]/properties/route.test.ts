// Tests for POST /api/customers/[customerId]/properties (manual "Add
// property" panel, #205). Mocks the lib functions directly (createPropertyForCustomer,
// getCustomer) rather than a fake Supabase client — mirrors rebook/route.test.ts's
// style (a thin route that translates a already-unit-tested lib call), not
// tags/route.test.ts's style (a route with no lib-level test coverage of its
// own to lean on). createPropertyForCustomer itself is thoroughly covered
// against a fake Supabase client in src/lib/customers.test.ts.
//
// Verifies:
//   1. Operator gate is enforced (denied → gate response, no write).
//   2. Bad UUID customerId → 400.
//   3. Strict body validation: missing/blank address, non-string nickname,
//      malformed JSON → 400.
//   4. Unknown customer id (getCustomer returns null) → 404, no create call.
//   5. Happy path: 200 with the created/resolved property.
//   6. A lib-level error → 500.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireOperatorMock, getCustomerMock, createPropertyMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<NextResponse | null> => null),
  getCustomerMock: vi.fn(),
  createPropertyMock: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
}));

vi.mock('@/lib/customers', () => ({
  getCustomer: getCustomerMock,
  createPropertyForCustomer: createPropertyMock,
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

const SOME_ROW = {
  id: 'prop-1',
  customer_id: VALID_UUID,
  address: '1 A St',
  address_key: '1 a st',
  lat: null,
  lng: null,
  nickname: null as string | null,
  archived_at: null as string | null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null); // default: authorized / gate dormant
  getCustomerMock.mockResolvedValue({ id: VALID_UUID });
  createPropertyMock.mockResolvedValue({ data: SOME_ROW, error: null });
});

describe('POST /api/customers/[customerId]/properties — operator gate', () => {
  it('returns the gate response and never creates when denied', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(makeReq({ address: '1 A St' }), makeParams(VALID_UUID));
    expect(res.status).toBe(401);
    expect(createPropertyMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/customers/[customerId]/properties — validation', () => {
  it('400s on a non-UUID customerId', async () => {
    const res = await POST(makeReq({ address: '1 A St' }), makeParams('not-a-uuid'));
    expect(res.status).toBe(400);
    expect(createPropertyMock).not.toHaveBeenCalled();
  });

  it('400s on malformed JSON body', async () => {
    const res = await POST(makeReq(undefined), makeParams(VALID_UUID));
    expect(res.status).toBe(400);
    expect(createPropertyMock).not.toHaveBeenCalled();
  });

  it('400s when address is missing', async () => {
    const res = await POST(makeReq({}), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('invalid-body');
    expect(createPropertyMock).not.toHaveBeenCalled();
  });

  it('400s when address is blank/whitespace-only', async () => {
    const res = await POST(makeReq({ address: '   ' }), makeParams(VALID_UUID));
    expect(res.status).toBe(400);
    expect(createPropertyMock).not.toHaveBeenCalled();
  });

  it('400s when address is not a string', async () => {
    const res = await POST(makeReq({ address: 123 }), makeParams(VALID_UUID));
    expect(res.status).toBe(400);
    expect(createPropertyMock).not.toHaveBeenCalled();
  });

  it.each([[1], [null], [{}], [[]]])('400s when nickname is a non-string value (%p)', async (value) => {
    const res = await POST(makeReq({ address: '1 A St', nickname: value }), makeParams(VALID_UUID));
    expect(res.status).toBe(400);
    expect(createPropertyMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/customers/[customerId]/properties — unknown customer', () => {
  it('404s when the customer does not exist, and never calls createPropertyForCustomer', async () => {
    getCustomerMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq({ address: '1 A St' }), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.error).toMatch(/not found/i);
    expect(createPropertyMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/customers/[customerId]/properties — happy path', () => {
  it('creates a property and returns it', async () => {
    const res = await POST(makeReq({ address: '1 A St', nickname: 'Home' }), makeParams(VALID_UUID));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.property).toEqual({ id: 'prop-1', address: '1 A St', nickname: null, archivedAt: null });
    expect(createPropertyMock).toHaveBeenCalledWith(VALID_UUID, { address: '1 A St', nickname: 'Home' });
  });

  it('passes nickname through as undefined when not provided', async () => {
    const res = await POST(makeReq({ address: '1 A St' }), makeParams(VALID_UUID));
    expect(res.status).toBe(200);
    expect(createPropertyMock).toHaveBeenCalledWith(VALID_UUID, { address: '1 A St', nickname: undefined });
  });

  it('maps a returned nickname/archivedAt through to the JSON response', async () => {
    createPropertyMock.mockResolvedValueOnce({
      data: { ...SOME_ROW, nickname: 'Beach House', archived_at: '2026-02-01T00:00:00Z' },
      error: null,
    });
    const res = await POST(makeReq({ address: '1 A St' }), makeParams(VALID_UUID));
    const json = await res.json();
    expect(json.property).toEqual({
      id: 'prop-1',
      address: '1 A St',
      nickname: 'Beach House',
      archivedAt: '2026-02-01T00:00:00Z',
    });
  });
});

describe('POST /api/customers/[customerId]/properties — errors', () => {
  it('500s when createPropertyForCustomer returns an error', async () => {
    createPropertyMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    const res = await POST(makeReq({ address: '1 A St' }), makeParams(VALID_UUID));
    expect(res.status).toBe(500);
  });

  it('500s when createPropertyForCustomer returns no data and no error', async () => {
    createPropertyMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(makeReq({ address: '1 A St' }), makeParams(VALID_UUID));
    expect(res.status).toBe(500);
  });
});
