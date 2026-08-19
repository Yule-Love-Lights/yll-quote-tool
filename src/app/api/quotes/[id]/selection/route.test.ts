// Tests for POST /api/quotes/[id]/selection (ledger row 239 — browsing
// selection autosave). Supabase, rate limit, and staff-preview detection
// mocked, mirroring the sibling /view + /interested route tests.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

type QuoteRow = { id: string; customer_approved_at: string | null; quote_sent_at: string | null };

const { state } = vi.hoisted(() => ({
  state: {
    isConfigured: true,
    quote: {
      id: 'q1',
      customer_approved_at: null,
      quote_sent_at: '2026-01-01T00:00:00Z',
    } as QuoteRow | null,
    fetchErr: null as { message: string } | null,
    updateErr: null as { message: string } | null,
    // Captured so tests can assert exactly what got written.
    lastUpdatePayload: null as Record<string, unknown> | null,
    lastEqId: null as string | null,
    lastIsFilter: null as [string, unknown] | null,
  },
}));

const { staff } = vi.hoisted(() => ({ staff: { current: false } }));

vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));
vi.mock('@/lib/auth/staffDevice', () => ({ isStaffPreview: async () => staff.current }));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => state.isConfigured,
  getSupabaseServiceClient: () => ({
    from: (_table: string) => ({
      select: () => ({
        eq: () => ({
          single: async () => ({ data: state.quote, error: state.fetchErr }),
        }),
      }),
      update: (payload: Record<string, unknown>) => {
        state.lastUpdatePayload = payload;
        return {
          eq: (_col: string, id: string) => {
            state.lastEqId = id;
            return {
              is: async (col: string, val: unknown) => {
                state.lastIsFilter = [col, val];
                return { error: state.updateErr };
              },
            };
          },
        };
      },
    }),
  }),
}));

import { POST, parseSelectionBody } from './route';

const VALID_ID = '11111111-1111-1111-1111-111111111111';
const ctx = (id = VALID_ID) => ({ params: Promise.resolve({ id }) });

function makeReq(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const VALID_BODY = {
  packageId: 'D',
  selectedItemIds: ['item-1', 'item-2'],
  rushSelected: true,
  takedownSelected: false,
  installTiming: 'september',
  colorSchemeId: 'red-green',
  customPattern: ['red', 'green'],
  permanentEffect: 'chase',
};

beforeEach(() => {
  vi.clearAllMocks();
  state.isConfigured = true;
  state.quote = { id: 'q1', customer_approved_at: null, quote_sent_at: '2026-01-01T00:00:00Z' };
  state.fetchErr = null;
  state.updateErr = null;
  state.lastUpdatePayload = null;
  state.lastEqId = null;
  state.lastIsFilter = null;
  staff.current = false;
});

describe('parseSelectionBody', () => {
  it('accepts a full valid body', () => {
    expect(parseSelectionBody(VALID_BODY)).toEqual(VALID_BODY);
  });

  it('rejects a missing/invalid packageId', () => {
    expect(parseSelectionBody({ ...VALID_BODY, packageId: 'Z' })).toBeNull();
    expect(parseSelectionBody({ ...VALID_BODY, packageId: undefined })).toBeNull();
  });

  it('rejects a non-array selectedItemIds', () => {
    expect(parseSelectionBody({ ...VALID_BODY, selectedItemIds: 'not-an-array' })).toBeNull();
  });

  it('rejects a non-object body', () => {
    expect(parseSelectionBody(null)).toBeNull();
    expect(parseSelectionBody('string')).toBeNull();
    expect(parseSelectionBody(42)).toBeNull();
  });

  it('drops non-string entries from selectedItemIds/customPattern instead of rejecting', () => {
    const parsed = parseSelectionBody({
      ...VALID_BODY,
      selectedItemIds: ['item-1', 42, null, 'item-2'],
      customPattern: ['red', 7],
    });
    expect(parsed?.selectedItemIds).toEqual(['item-1', 'item-2']);
    expect(parsed?.customPattern).toEqual(['red']);
  });

  it('sanitizes an invalid installTiming to "none" instead of rejecting', () => {
    const parsed = parseSelectionBody({ ...VALID_BODY, installTiming: 'garbage' });
    expect(parsed?.installTiming).toBe('none');
  });

  it('drops an invalid permanentEffect instead of rejecting', () => {
    const parsed = parseSelectionBody({ ...VALID_BODY, permanentEffect: 'not-a-real-effect' });
    expect(parsed?.permanentEffect).toBeUndefined();
  });

  it('omits optional fields entirely when absent (never writes them as undefined)', () => {
    const parsed = parseSelectionBody({
      packageId: 'A',
      selectedItemIds: [],
      rushSelected: false,
      takedownSelected: false,
      installTiming: 'none',
    });
    expect(parsed).toEqual({
      packageId: 'A',
      selectedItemIds: [],
      rushSelected: false,
      takedownSelected: false,
      installTiming: 'none',
    });
  });
});

describe('POST /api/quotes/[id]/selection', () => {
  it('503s when Supabase service role is not configured', async () => {
    state.isConfigured = false;
    const res = await POST(makeReq(VALID_BODY), ctx());
    expect(res.status).toBe(503);
  });

  it('400s an invalid quote id', async () => {
    const res = await POST(makeReq(VALID_BODY), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('skips a staff preview BEFORE any DB work', async () => {
    staff.current = true;
    const res = await POST(makeReq(VALID_BODY), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.skipped).toBe('staff');
    expect(state.lastUpdatePayload).toBeNull();
  });

  it('400s malformed JSON', async () => {
    const req = { json: async () => { throw new Error('bad json'); } } as unknown as NextRequest;
    const res = await POST(req, ctx());
    expect(res.status).toBe(400);
  });

  it('400s an invalid selection payload', async () => {
    const res = await POST(makeReq({ packageId: 'Z' }), ctx());
    expect(res.status).toBe(400);
  });

  it('404s when the quote does not exist', async () => {
    state.quote = null;
    const res = await POST(makeReq(VALID_BODY), ctx());
    expect(res.status).toBe(404);
  });

  it('skips as not-sent when the quote has never been sent', async () => {
    state.quote = { id: 'q1', customer_approved_at: null, quote_sent_at: null };
    const res = await POST(makeReq(VALID_BODY), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.skipped).toBe('not-sent');
    expect(state.lastUpdatePayload).toBeNull();
  });

  it('skips as approved and NEVER writes once customer_approved_at is set — the frozen snapshot always wins', async () => {
    state.quote = {
      id: 'q1',
      customer_approved_at: '2026-01-02T00:00:00Z',
      quote_sent_at: '2026-01-01T00:00:00Z',
    };
    const res = await POST(makeReq(VALID_BODY), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.skipped).toBe('approved');
    expect(state.lastUpdatePayload).toBeNull();
  });

  it('saves a valid selection, guarded by .is(customer_approved_at, null) on the write', async () => {
    const res = await POST(makeReq(VALID_BODY), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(state.lastEqId).toBe(VALID_ID);
    expect(state.lastIsFilter).toEqual(['customer_approved_at', null]);
    expect(state.lastUpdatePayload).toMatchObject({
      browsing_selection: {
        packageId: 'D',
        selectedItemIds: ['item-1', 'item-2'],
        rushSelected: true,
        takedownSelected: false,
        installTiming: 'september',
        colorSchemeId: 'red-green',
        customPattern: ['red', 'green'],
        permanentEffect: 'chase',
      },
    });
    expect(typeof state.lastUpdatePayload!.browsing_selection_updated_at).toBe('string');
  });

  it('500s when the update fails', async () => {
    state.updateErr = { message: 'db exploded' };
    const res = await POST(makeReq(VALID_BODY), ctx());
    expect(res.status).toBe(500);
  });
});
