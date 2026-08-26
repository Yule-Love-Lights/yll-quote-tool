// Bouncie webhook receiver — the gate, the capture, and the two footguns.
//
// The real secret check runs here (only Supabase is mocked), because the whole
// security value of this route is that check plus its perimeter entry. Row 403
// constraint (b) requires both, and the signed-out perimeter test at the bottom
// is the one that has historically been skipped and produced prod incidents.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { insert, getSupabaseServiceClient } = vi.hoisted(() => {
  const insert = vi.fn(async (_row: Record<string, unknown>) => ({
    error: null as { code?: string; message: string } | null,
  }));
  return {
    insert,
    getSupabaseServiceClient: vi.fn(() => ({ from: () => ({ insert }) })),
  };
});

/** The row handed to `insert` on the nth call. */
function insertedRow(n = 0): Record<string, unknown> {
  const call = insert.mock.calls[n];
  if (!call) throw new Error(`insert was not called ${n + 1} time(s)`);
  return call[0];
}

vi.mock('@/lib/supabase', () => ({ getSupabaseServiceClient }));

import { GET, POST } from './route';
import { isPublicPath } from '@/lib/auth/operatorGate';

const SECRET = 'bouncie-shared-secret-value';
const PATH = '/api/integrations/bouncie/webhook';

function makeReq(body: string, headers: Record<string, string> = {}): NextRequest {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    headers: { get: (k: string) => lower[k.toLowerCase()] ?? null },
    text: async () => body,
  } as unknown as NextRequest;
}

const tripStart = JSON.stringify({
  eventType: 'tripStart',
  imei: '123456789012345',
  vin: '1HGBIQOJXMN109186',
  transactionId: '123456789012345-1735920000-202501',
  start: { timestamp: '2026-08-26T13:00:00.000Z', timeZone: 'America/New_York', odometer: 45678.9 },
});

let prevSecret: string | undefined;

beforeEach(() => {
  prevSecret = process.env.BOUNCIE_WEBHOOK_SECRET;
  process.env.BOUNCIE_WEBHOOK_SECRET = SECRET;
  insert.mockClear();
  insert.mockResolvedValue({ error: null });
  getSupabaseServiceClient.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (prevSecret === undefined) delete process.env.BOUNCIE_WEBHOOK_SECRET;
  else process.env.BOUNCIE_WEBHOOK_SECRET = prevSecret;
  vi.restoreAllMocks();
});

describe('the shared-secret gate', () => {
  it('401s with no secret header, and stores nothing', async () => {
    const res = await POST(makeReq(tripStart));
    expect(res.status).toBe(401);
    expect(insert).not.toHaveBeenCalled();
  });

  it('401s on a wrong secret, and stores nothing', async () => {
    const res = await POST(makeReq(tripStart, { authorization: 'wrong' }));
    expect(res.status).toBe(401);
    expect(insert).not.toHaveBeenCalled();
  });

  it('accepts the secret in Authorization', async () => {
    const res = await POST(makeReq(tripStart, { authorization: SECRET }));
    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledOnce();
  });

  it('accepts the secret in X-Bouncie-Authorization, for platforms that strip Authorization', async () => {
    const res = await POST(makeReq(tripStart, { 'x-bouncie-authorization': SECRET }));
    expect(res.status).toBe(200);
    expect(insert).toHaveBeenCalledOnce();
  });

  it('FAILS CLOSED when BOUNCIE_WEBHOOK_SECRET is unset — an unconfigured deploy stores nothing', async () => {
    delete process.env.BOUNCIE_WEBHOOK_SECRET;
    const res = await POST(makeReq(tripStart, { authorization: 'anything' }));
    expect(res.status).toBe(401);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('the body is not read until the secret passes', () => {
  // S68 security lens: reading first let an unauthenticated caller make us hold
  // their payload in memory for nothing. The secret is header-only, so it can be
  // checked first.
  it('never touches the body on a bad secret', async () => {
    const text = vi.fn(async () => tripStart);
    const req = {
      headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? 'wrong' : null) },
      text,
    } as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(text).not.toHaveBeenCalled();
  });

  it('reads the body once the secret passes', async () => {
    const text = vi.fn(async () => tripStart);
    const req = {
      headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? SECRET : null) },
      text,
    } as unknown as NextRequest;
    await POST(req);
    expect(text).toHaveBeenCalledOnce();
  });
});

describe('ROW 403 CONSTRAINT (f) — off-hours tagging', () => {
  it('tags a workday-afternoon event as in-hours', async () => {
    const body = JSON.stringify({ eventType: 'tripStart', start: { timestamp: '2026-08-26T18:00:00.000Z' } });
    await POST(makeReq(body, { authorization: SECRET }));
    expect(insertedRow().occurred_off_hours).toBe(false);
  });

  it('tags a late-night event as OFF-hours, so a purge job can find it', async () => {
    // The truck goes home with an employee. This is the row that records their
    // private evening, and it has to be findable without re-parsing payloads.
    const body = JSON.stringify({ eventType: 'tripEnd', end: { timestamp: '2026-08-27T03:00:00.000Z' } });
    await POST(makeReq(body, { authorization: SECRET }));
    expect(insertedRow().occurred_off_hours).toBe(true);
  });

  it('stores NULL, not false, when the event carried no usable timestamp', async () => {
    await POST(makeReq(JSON.stringify({ eventType: 'tripStart' }), { authorization: SECRET }));
    expect(insertedRow().occurred_off_hours).toBeNull();
  });
});

describe('THE ROTATION FOOTGUN', () => {
  // Bouncie rotates our shared secret when the endpoint returns a NEW value in
  // an Authorization RESPONSE header. Setting it by accident silently adopts
  // that value and breaks every later delivery, with no error anywhere.
  it('never sets an Authorization response header, on any path', async () => {
    const responses = [
      await POST(makeReq(tripStart, { authorization: SECRET })),
      await POST(makeReq(tripStart, { authorization: 'wrong' })),
      await POST(makeReq('not json', { authorization: SECRET })),
      await GET(),
    ];
    for (const res of responses) {
      expect(res.headers.get('authorization')).toBeNull();
      expect(res.headers.get('x-bouncie-authorization')).toBeNull();
    }
  });
});

describe('capture', () => {
  it('stores the parsed facts alongside the raw payload', async () => {
    await POST(makeReq(tripStart, { authorization: SECRET }));
    const row = insertedRow();
    expect(row).toMatchObject({
      event_type: 'tripStart',
      imei: '123456789012345',
      vin: '1HGBIQOJXMN109186',
      transaction_id: '123456789012345-1735920000-202501',
      occurred_at: '2026-08-26T13:00:00.000Z',
    });
    expect(row.payload).toEqual(JSON.parse(tripStart));
    expect(typeof row.body_sha256).toBe('string');
  });

  it('STORES a body that is not JSON rather than discarding it', async () => {
    // A spec mismatch is the most valuable thing this phase can catch.
    const res = await POST(makeReq('<html>nope</html>', { authorization: SECRET }));
    expect(res.status).toBe(200);
    const row = insertedRow();
    expect(row.payload).toEqual({ _unparsed: '<html>nope</html>' });
    expect(row.event_type).toBeNull();
  });

  it('STORES an event whose shape does not match the spec, with null facts', async () => {
    const surprise = JSON.stringify({ somethingBouncieNeverDocumented: true });
    const res = await POST(makeReq(surprise, { authorization: SECRET }));
    expect(res.status).toBe(200);
    const row = insertedRow();
    expect(row.event_type).toBeNull();
    expect(row.imei).toBeNull();
    expect(row.payload).toEqual({ somethingBouncieNeverDocumented: true });
  });

  it('gives two different bodies two different hashes', async () => {
    await POST(makeReq(tripStart, { authorization: SECRET }));
    await POST(makeReq(JSON.stringify({ eventType: 'tripEnd' }), { authorization: SECRET }));
    const a = insertedRow(0).body_sha256;
    const b = insertedRow(1).body_sha256;
    expect(a).not.toBe(b);
  });

  it('rejects an oversized body with a 200, so Bouncie does not retry it forever', async () => {
    const res = await POST(makeReq('x'.repeat(1_000_001), { authorization: SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stored: false, reason: 'oversized' });
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('status codes, which drive Bouncie retries and auto-deactivation', () => {
  it('treats a duplicate redelivery as SUCCESS, not an error', async () => {
    // Bouncie documents duplicates as normal: overlapping real-time and periodic
    // streams, plus buffered dumps after a device regains signal. A non-2xx here
    // would make it retry a body that can never succeed.
    insert.mockResolvedValueOnce({ error: { code: '23505', message: 'duplicate key' } });
    const res = await POST(makeReq(tripStart, { authorization: SECRET }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ stored: false, reason: 'duplicate' });
  });

  it('503s on a real storage failure, so the event IS retried', async () => {
    insert.mockResolvedValueOnce({ error: { code: '08006', message: 'connection failure' } });
    const res = await POST(makeReq(tripStart, { authorization: SECRET }));
    expect(res.status).toBe(503);
  });

  it('503s when the service client is unavailable', async () => {
    getSupabaseServiceClient.mockReturnValueOnce(null as never);
    const res = await POST(makeReq(tripStart, { authorization: SECRET }));
    expect(res.status).toBe(503);
  });

  it('GET returns 200 for an ops reachability check', async () => {
    expect((await GET()).status).toBe(200);
  });
});

describe('ROW 403 CONSTRAINT (b) — the perimeter entry', () => {
  // A Bouncie request carries no operator session. Without this entry the
  // middleware 401s it before the route's own secret check ever runs, and the
  // webhook silently receives nothing. That exact gap has produced four prod
  // incidents in this repo, which is why this is a test and not an inspection.
  it('the webhook path is public to a SIGNED-OUT request', () => {
    expect(isPublicPath(PATH, 'POST')).toBe(true);
  });

  it('sibling paths under the same prefix are NOT public', () => {
    expect(isPublicPath('/api/integrations/bouncie', 'POST')).toBe(false);
    expect(isPublicPath('/api/integrations/bouncie/vehicles', 'GET')).toBe(false);
    expect(isPublicPath(`${PATH}/extra`, 'POST')).toBe(false);
  });
});
