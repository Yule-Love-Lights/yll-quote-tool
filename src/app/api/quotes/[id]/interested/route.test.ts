// #110 W6-016: POST /api/quotes/[id]/interested had no test coverage despite
// several branchy skip outcomes (not-sent, already, log-unavailable, error)
// plus the success path, driven by a possibly-unmigrated `kind` column.
// Supabase + rate limit mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

type QuoteRow = { id: string; quote_sent_at: string | null };

const { state } = vi.hoisted(() => ({
  state: {
    isConfigured: true,
    quote: { id: 'q1', quote_sent_at: '2026-01-01T00:00:00Z' } as QuoteRow | null,
    fetchErr: null as { message: string } | null,
    checkExisting: [] as { id: string }[],
    checkErr: null as { message: string } | null,
    insErr: null as { message: string } | null,
    throwOnCheck: false,
  },
}));

const { staff } = vi.hoisted(() => ({ staff: { current: false } }));

vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));

// Staff-preview detection is unit-tested in lib/auth/staffDevice.test.ts; here we
// just drive its outcome to confirm the route honours a staff skip.
vi.mock('@/lib/auth/staffDevice', () => ({ isStaffPreview: async () => staff.current }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => state.isConfigured,
  getSupabaseServiceClient: () => ({
    from: (table: string) => {
      if (table === 'quotes') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: state.quote, error: state.fetchErr }),
            }),
          }),
        };
      }
      // quote_view_events
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              limit: async () => {
                if (state.throwOnCheck) throw new Error('boom');
                return { data: state.checkExisting, error: state.checkErr };
              },
            }),
          }),
        }),
        insert: async () => ({ error: state.insErr }),
      };
    },
  }),
}));

import { POST } from './route';

const VALID_ID = '11111111-1111-1111-1111-111111111111';
const ctx = (id = VALID_ID) => ({ params: Promise.resolve({ id }) });
const req = {} as NextRequest;

beforeEach(() => {
  vi.clearAllMocks();
  state.isConfigured = true;
  state.quote = { id: 'q1', quote_sent_at: '2026-01-01T00:00:00Z' };
  state.fetchErr = null;
  state.checkExisting = [];
  state.checkErr = null;
  state.insErr = null;
  state.throwOnCheck = false;
  staff.current = false;
});

describe('POST /api/quotes/[id]/interested', () => {
  it('503s when Supabase service role is not configured', async () => {
    state.isConfigured = false;
    const res = await POST(req, ctx());
    expect(res.status).toBe(503);
  });

  it('400s an invalid quote id', async () => {
    const res = await POST(req, ctx('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('404s when the quote does not exist', async () => {
    state.quote = null;
    const res = await POST(req, ctx());
    expect(res.status).toBe(404);
  });

  it('skips as not-sent when the quote has never been sent', async () => {
    state.quote = { id: 'q1', quote_sent_at: null };
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.skipped).toBe('not-sent');
  });

  it('records interest on the first call', async () => {
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.skipped).toBeUndefined();
  });

  it('skips a staff preview (S22) — before any DB work', async () => {
    staff.current = true;
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.skipped).toBe('staff');
  });

  it('skips as already when an interested event already exists', async () => {
    state.checkExisting = [{ id: 'ev1' }];
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.skipped).toBe('already');
  });

  it('degrades to log-unavailable when the existence check errors (kind not migrated)', async () => {
    state.checkErr = { message: 'column "kind" does not exist' };
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.skipped).toBe('log-unavailable');
  });

  it('degrades to log-unavailable when the insert errors', async () => {
    state.insErr = { message: 'insert failed' };
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.skipped).toBe('log-unavailable');
  });

  it('degrades to error when an unexpected exception is thrown', async () => {
    state.throwOnCheck = true;
    const res = await POST(req, ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.skipped).toBe('error');
  });
});
