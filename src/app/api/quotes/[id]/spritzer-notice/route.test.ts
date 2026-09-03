// Tests for POST /api/quotes/[id]/spritzer-notice. Operator-gated. Flips ONE
// boolean inside the quote's `inputs` jsonb so the portal stops (or resumes)
// telling this customer about free spritzers. The auth gate and Supabase are
// mocked; what these pin is that the route writes only that flag, never money,
// and refuses to report success if the total moves under it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';

const { sbRef, requireOperatorMock, getOperatorMock } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async (): Promise<unknown> => ({ email: 'staff@yulelovelights.com' })),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
  getSupabaseClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));

import { POST } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = (body: unknown) => ({ json: async () => body }) as unknown as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

type Row = Record<string, unknown>;

/** `before` is served to the first select, `after` to the read-back. */
function makeSb(before: Row | null, after?: Row | null, casRows: Row[] = [{ id: ID }]) {
  const updates: Row[] = [];
  let reads = 0;
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: () => b,
    eq: () => b,
    update: (patch: Row) => {
      updates.push(patch);
      return b;
    },
    // The route CASes on the inputs jsonb and reads back the affected rows.
    // `casRows` lets a test model a concurrent write (zero rows matched).
    select: (cols?: string) => (cols === 'id' ? Promise.resolve({ data: casRows, error: null }) : b),
    single: async () => {
      reads += 1;
      const row = reads === 1 ? before : (after === undefined ? before : after);
      return row ? { data: row, error: null } : { data: null, error: { message: 'no row' } };
    },
  });
  return { client: b, updates };
}

const baseQuote = (inputs: Row | null = { santasFootage: 10 }, total = 1234.5): Row => ({
  id: ID,
  inputs,
  total,
});

beforeEach(() => {
  requireOperatorMock.mockReset().mockResolvedValue(null);
  getOperatorMock.mockReset().mockResolvedValue({ email: 'staff@yulelovelights.com' });
  sbRef.current = null;
});

describe('POST /api/quotes/[id]/spritzer-notice', () => {
  it('refuses anyone who is not a signed-in operator', async () => {
    requireOperatorMock.mockResolvedValue(denied401());
    const res = await POST(req({ suppressed: true }), ctx());
    expect(res.status).toBe(401);
  });

  it('turns the notice off and writes ONLY that flag', async () => {
    const { client, updates } = makeSb(
      baseQuote({ santasFootage: 10, waiveMinimum: true }),
      baseQuote({ santasFootage: 10, waiveMinimum: true, suppressFreeSpritzerNotice: true }),
    );
    sbRef.current = client;

    const res = await POST(req({ suppressed: true }), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, suppressed: true });
    expect(updates).toHaveLength(1);
    // The patch names exactly one column, and that column keeps every other
    // input untouched.
    expect(Object.keys(updates[0])).toEqual(['inputs']);
    expect(updates[0].inputs).toEqual({
      santasFootage: 10,
      waiveMinimum: true,
      suppressFreeSpritzerNotice: true,
    });
  });

  it('turns it back on again', async () => {
    const { client, updates } = makeSb(
      baseQuote({ santasFootage: 10, suppressFreeSpritzerNotice: true }),
      baseQuote({ santasFootage: 10, suppressFreeSpritzerNotice: false }),
    );
    sbRef.current = client;

    const res = await POST(req({ suppressed: false }), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, suppressed: false });
    expect(updates[0].inputs).toMatchObject({ suppressFreeSpritzerNotice: false });
  });

  it('never writes the total, the result, or the approval snapshot', async () => {
    const { client, updates } = makeSb(baseQuote());
    sbRef.current = client;
    await POST(req({ suppressed: true }), ctx());
    const patched = Object.keys(updates[0]);
    expect(patched).not.toContain('total');
    expect(patched).not.toContain('result');
    expect(patched).not.toContain('approval_snapshot');
    expect(patched).not.toContain('deposit_amount_usd');
  });

  it('refuses to report success when the total moved during the write', async () => {
    // The update names only `inputs`, so this should be impossible. The check
    // exists so that if it ever happens, staff are told rather than reassured.
    const { client } = makeSb(baseQuote({ santasFootage: 10 }, 1234.5), baseQuote({ santasFootage: 10 }, 999));
    sbRef.current = client;

    const res = await POST(req({ suppressed: true }), ctx());
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/total changed/i);
  });

  it('refuses when someone else saved the quote in the gap, and changes nothing', async () => {
    // The CAS matched zero rows: a builder Calculate landed between our read
    // and our write. Overwriting would revert their whole inputs blob.
    const { client } = makeSb(baseQuote(), baseQuote(), []);
    sbRef.current = client;
    const res = await POST(req({ suppressed: true }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('conflict');
  });

  it('rejects a body that is not a boolean flag', async () => {
    sbRef.current = makeSb(baseQuote()).client;
    for (const bad of [{}, { suppressed: 'yes' }, { suppressed: 1 }, null]) {
      const res = await POST(req(bad), ctx());
      expect(res.status).toBe(400);
    }
  });

  it('rejects a malformed quote id before touching the database', async () => {
    sbRef.current = makeSb(baseQuote()).client;
    const res = await POST(req({ suppressed: true }), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('404s an unknown quote', async () => {
    sbRef.current = makeSb(null).client;
    const res = await POST(req({ suppressed: true }), ctx());
    expect(res.status).toBe(404);
  });

  it('refuses a quote with no saved inputs rather than inventing an inputs object', async () => {
    const { client, updates } = makeSb(baseQuote(null));
    sbRef.current = client;
    const res = await POST(req({ suppressed: true }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no-inputs');
    expect(updates).toHaveLength(0);
  });
});
