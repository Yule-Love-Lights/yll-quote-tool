// Tests for POST /api/customers/[customerId]/properties/[propertyId]
// (nickname edit + archive/unarchive, #205). Mocks the lib functions
// directly (updateProperty/archiveProperty/unarchiveProperty), mirroring
// rebook/route.test.ts's style — see the sibling route.test.ts in this
// folder for the same rationale. Those lib functions are thoroughly
// covered against a fake Supabase client in src/lib/customers.test.ts,
// including the customer-ownership guard this route depends on.
//
// Verifies:
//   1. Operator gate is enforced.
//   2. Bad UUID customerId/propertyId → 400.
//   3. Strict body validation: malformed JSON, neither field provided,
//      non-string/non-null nickname, non-boolean archived → 400.
//   4. Happy path: nickname-only, archived-only (both directions), and
//      both-in-one-call all route to the right lib call(s).
//   5. "Not found" (lib returns {data: null, error: null} — the ownership-
//      guard shape) → 404.
//   6. A lib-level error → 500.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { requireOperatorMock, updatePropertyMock, archivePropertyMock, unarchivePropertyMock } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<NextResponse | null> => null),
  updatePropertyMock: vi.fn(),
  archivePropertyMock: vi.fn(),
  unarchivePropertyMock: vi.fn(),
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
}));

vi.mock('@/lib/customers', () => ({
  updateProperty: updatePropertyMock,
  archiveProperty: archivePropertyMock,
  unarchiveProperty: unarchivePropertyMock,
}));

import { POST } from './route';

const CUSTOMER_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PROPERTY_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

function makeReq(body?: unknown): NextRequest {
  return {
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
  } as unknown as NextRequest;
}

function makeParams(customerId: string, propertyId: string) {
  return { params: Promise.resolve({ customerId, propertyId }) };
}

const SOME_ROW = {
  id: PROPERTY_ID,
  customer_id: CUSTOMER_ID,
  address: '1 A St',
  address_key: '1 a st',
  lat: null,
  lng: null,
  nickname: 'Home' as string | null,
  archived_at: null as string | null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null); // default: authorized / gate dormant
  updatePropertyMock.mockResolvedValue({ data: SOME_ROW, error: null });
  archivePropertyMock.mockResolvedValue({ data: { ...SOME_ROW, archived_at: '2026-01-02T00:00:00Z' }, error: null });
  unarchivePropertyMock.mockResolvedValue({ data: SOME_ROW, error: null });
});

describe('POST /api/customers/[customerId]/properties/[propertyId] — operator gate', () => {
  it('returns the gate response and never writes when denied', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(makeReq({ nickname: 'Home' }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    expect(res.status).toBe(401);
    expect(updatePropertyMock).not.toHaveBeenCalled();
  });
});

describe('POST .../properties/[propertyId] — validation', () => {
  it('400s on a non-UUID customerId', async () => {
    const res = await POST(makeReq({ nickname: 'x' }), makeParams('not-a-uuid', PROPERTY_ID));
    expect(res.status).toBe(400);
    expect(updatePropertyMock).not.toHaveBeenCalled();
  });

  it('400s on a non-UUID propertyId', async () => {
    const res = await POST(makeReq({ nickname: 'x' }), makeParams(CUSTOMER_ID, 'not-a-uuid'));
    expect(res.status).toBe(400);
    expect(updatePropertyMock).not.toHaveBeenCalled();
  });

  it('400s on malformed JSON body', async () => {
    const res = await POST(makeReq(undefined), makeParams(CUSTOMER_ID, PROPERTY_ID));
    expect(res.status).toBe(400);
    expect(updatePropertyMock).not.toHaveBeenCalled();
  });

  it('400s when neither nickname nor archived is provided', async () => {
    const res = await POST(makeReq({}), makeParams(CUSTOMER_ID, PROPERTY_ID));
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('invalid-body');
    expect(updatePropertyMock).not.toHaveBeenCalled();
  });

  it.each([[1], [{}], [[]]])('400s when nickname is a non-string/non-null value (%p)', async (value) => {
    const res = await POST(makeReq({ nickname: value }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    expect(res.status).toBe(400);
    expect(updatePropertyMock).not.toHaveBeenCalled();
  });

  it('allows an explicit null nickname (a clear)', async () => {
    const res = await POST(makeReq({ nickname: null }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    expect(res.status).toBe(200);
    expect(updatePropertyMock).toHaveBeenCalledWith(CUSTOMER_ID, PROPERTY_ID, { nickname: null });
  });

  it.each([['true'], [1], [null], [{}]])('400s when archived is a non-boolean value (%p)', async (value) => {
    const res = await POST(makeReq({ archived: value }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    expect(res.status).toBe(400);
    expect(archivePropertyMock).not.toHaveBeenCalled();
    expect(unarchivePropertyMock).not.toHaveBeenCalled();
  });
});

describe('POST .../properties/[propertyId] — happy path', () => {
  it('edits the nickname only', async () => {
    const res = await POST(makeReq({ nickname: 'Beach House' }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(updatePropertyMock).toHaveBeenCalledWith(CUSTOMER_ID, PROPERTY_ID, { nickname: 'Beach House' });
    expect(archivePropertyMock).not.toHaveBeenCalled();
    expect(unarchivePropertyMock).not.toHaveBeenCalled();
  });

  it('archives the property (archived: true)', async () => {
    const res = await POST(makeReq({ archived: true }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.property.archivedAt).toBe('2026-01-02T00:00:00Z');
    expect(archivePropertyMock).toHaveBeenCalledWith(CUSTOMER_ID, PROPERTY_ID);
    expect(updatePropertyMock).not.toHaveBeenCalled();
    expect(unarchivePropertyMock).not.toHaveBeenCalled();
  });

  it('unarchives the property (archived: false)', async () => {
    const res = await POST(makeReq({ archived: false }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    expect(res.status).toBe(200);
    expect(unarchivePropertyMock).toHaveBeenCalledWith(CUSTOMER_ID, PROPERTY_ID);
    expect(archivePropertyMock).not.toHaveBeenCalled();
  });

  it('applies both nickname and archived in one call', async () => {
    const res = await POST(
      makeReq({ nickname: 'Beach House', archived: true }),
      makeParams(CUSTOMER_ID, PROPERTY_ID),
    );
    expect(res.status).toBe(200);
    expect(updatePropertyMock).toHaveBeenCalledWith(CUSTOMER_ID, PROPERTY_ID, { nickname: 'Beach House' });
    expect(archivePropertyMock).toHaveBeenCalledWith(CUSTOMER_ID, PROPERTY_ID);
  });
});

describe('POST .../properties/[propertyId] — not found (ownership guard)', () => {
  it('404s when the nickname-edit target does not belong to this customer / does not exist', async () => {
    updatePropertyMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(makeReq({ nickname: 'x' }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.error).toMatch(/not found/i);
  });

  it('404s when the archive target does not belong to this customer / does not exist', async () => {
    archivePropertyMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(makeReq({ archived: true }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    expect(res.status).toBe(404);
  });

  it('404s when the unarchive target does not belong to this customer / does not exist', async () => {
    unarchivePropertyMock.mockResolvedValueOnce({ data: null, error: null });
    const res = await POST(makeReq({ archived: false }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    expect(res.status).toBe(404);
  });
});

describe('POST .../properties/[propertyId] — errors', () => {
  it('500s on a nickname-update db error', async () => {
    updatePropertyMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    const res = await POST(makeReq({ nickname: 'x' }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    expect(res.status).toBe(500);
  });

  it('500s on an archive db error', async () => {
    archivePropertyMock.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    const res = await POST(makeReq({ archived: true }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    expect(res.status).toBe(500);
  });
});

describe('POST .../properties/[propertyId] — address correction (the geocode fix-list)', () => {
  it('passes the address through to updateProperty and returns the row WITH lat/lng', async () => {
    updatePropertyMock.mockResolvedValue({
      data: { ...SOME_ROW, address: '6 Birch Rd, Amityville, NY 11701', lat: 40.711, lng: -73.404 },
      error: null,
    });
    const res = await POST(makeReq({ address: '6 Birch Rd, Amityville, NY 11701' }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { property: { lat: number | null; lng: number | null } };
    // The fix-list tells VERIFIED from still-refused by these fields; a response
    // without them made both outcomes look identical (the S68 lens round).
    expect(body.property.lat).toBe(40.711);
    expect(body.property.lng).toBe(-73.404);
    expect(updatePropertyMock).toHaveBeenCalledWith(CUSTOMER_ID, PROPERTY_ID, {
      address: '6 Birch Rd, Amityville, NY 11701',
    });
  });

  it('a still-refused correction returns lat null, so the caller can say so', async () => {
    updatePropertyMock.mockResolvedValue({ data: { ...SOME_ROW, lat: null, lng: null }, error: null });
    const res = await POST(makeReq({ address: '1 Nowhere Ln' }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    const body = (await res.json()) as { property: { lat: number | null } };
    expect(body.property.lat).toBeNull();
  });

  it('surfaces the duplicate-address collision as a 409', async () => {
    updatePropertyMock.mockResolvedValue({ data: null, error: { message: 'duplicate key value (23505)' } });
    const res = await POST(makeReq({ address: '1 A St' }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    expect(res.status).toBe(409);
  });

  it('rejects an empty address', async () => {
    const res = await POST(makeReq({ address: '   ' }), makeParams(CUSTOMER_ID, PROPERTY_ID));
    expect(res.status).toBe(400);
  });
});
