// Tests for POST /api/quotes/[id]/staff-selection (ledger row 324 — staff
// pre-selects the customer's opening portal selection). Mirrors the
// sibling customer /selection route tests for parse/write behavior, and
// staff-approve's tests for the operator-auth + atomic-guard shape.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

type QuoteRow = {
  id: string;
  customer_approved_at: string | null;
  deposit_paid_at: string | null;
  status: string | null;
};

const { requireOperatorMock, getOperatorMock, state } = vi.hoisted(() => ({
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async () => null as { email: string | null } | null),
  state: {
    isConfigured: true,
    quote: {
      id: 'q1',
      customer_approved_at: null,
      deposit_paid_at: null,
      status: 'sent',
    } as QuoteRow | null,
    fetchErr: null as { message: string } | null,
    updateErr: null as { message: string } | null,
    // Fix-round MED: the guarded update now `.select('id')`s its affected
    // rows. Defaults to "the write matched one row" so every pre-existing
    // test (which never cared about this) keeps passing; the new race test
    // below sets this to [] to simulate a lost TOCTOU race.
    updatedRows: [{ id: 'q1' }] as { id: string }[] | null,
    lastUpdatePayload: null as Record<string, unknown> | null,
    lastEqId: null as string | null,
    lastIsFilter: null as [string, unknown] | null,
  },
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));

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
              is: (col: string, val: unknown) => {
                state.lastIsFilter = [col, val];
                return {
                  select: async (_cols: string) => ({ data: state.updatedRows, error: state.updateErr }),
                };
              },
            };
          },
        };
      },
    }),
  }),
}));

import { POST } from './route';

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
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue({ email: 'operator@example.com' });
  state.isConfigured = true;
  state.quote = { id: 'q1', customer_approved_at: null, deposit_paid_at: null, status: 'sent' };
  state.fetchErr = null;
  state.updateErr = null;
  state.updatedRows = [{ id: 'q1' }];
  state.lastUpdatePayload = null;
  state.lastEqId = null;
  state.lastIsFilter = null;
});

describe('POST /api/quotes/[id]/staff-selection', () => {
  it('401s (via requireOperator) when there is no operator session', async () => {
    const { NextResponse } = await import('next/server');
    requireOperatorMock.mockResolvedValueOnce(NextResponse.json({ error: 'Unauthorized' }, { status: 401 }));
    const res = await POST(makeReq(VALID_BODY), ctx());
    expect(res.status).toBe(401);
    expect(state.lastUpdatePayload).toBeNull();
  });

  it('503s when Supabase service role is not configured', async () => {
    state.isConfigured = false;
    const res = await POST(makeReq(VALID_BODY), ctx());
    expect(res.status).toBe(503);
  });

  it('400s an invalid quote id', async () => {
    const res = await POST(makeReq(VALID_BODY), ctx('not-a-uuid'));
    expect(res.status).toBe(400);
  });

  it('400s malformed JSON', async () => {
    const req = { json: async () => { throw new Error('bad json'); } } as unknown as NextRequest;
    const res = await POST(req, ctx());
    expect(res.status).toBe(400);
  });

  it('400s an invalid selection payload (reuses parseSelectionBody)', async () => {
    const res = await POST(makeReq({ packageId: 'Z' }), ctx());
    expect(res.status).toBe(400);
  });

  it('404s when the quote does not exist', async () => {
    state.quote = null;
    const res = await POST(makeReq(VALID_BODY), ctx());
    expect(res.status).toBe(404);
  });

  it('saves on a NEVER-SENT draft quote — the row 324 primary use case, unlike the customer route which skips unsent quotes', async () => {
    state.quote = { id: 'q1', customer_approved_at: null, deposit_paid_at: null, status: 'draft' };
    const res = await POST(makeReq(VALID_BODY), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(state.lastUpdatePayload).not.toBeNull();
  });

  it.each(['approved', 'booked'] as const)(
    '409s "locked" and never writes once customer_approved_at is set (status %s)',
    async (status) => {
      state.quote = {
        id: 'q1',
        customer_approved_at: '2026-01-02T00:00:00Z',
        deposit_paid_at: status === 'booked' ? '2026-01-02T01:00:00Z' : null,
        status,
      };
      const res = await POST(makeReq(VALID_BODY), ctx());
      const json = await res.json();
      expect(res.status).toBe(409);
      expect(json.code).toBe('locked');
      expect(state.lastUpdatePayload).toBeNull();
    },
  );

  it('409s "locked" when deposit_paid_at is set even if customer_approved_at somehow is not (belt-and-suspenders)', async () => {
    state.quote = { id: 'q1', customer_approved_at: null, deposit_paid_at: '2026-01-02T01:00:00Z', status: 'booked' };
    const res = await POST(makeReq(VALID_BODY), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('locked');
    expect(state.lastUpdatePayload).toBeNull();
  });

  it.each(['cancelled', 'changes_requested'] as const)(
    '409s "inactive" and never writes when status is %s',
    async (status) => {
      state.quote = { id: 'q1', customer_approved_at: null, deposit_paid_at: null, status };
      const res = await POST(makeReq(VALID_BODY), ctx());
      const json = await res.json();
      expect(res.status).toBe(409);
      expect(json.code).toBe('inactive');
      expect(state.lastUpdatePayload).toBeNull();
    },
  );

  // Row 236 x row 324 compose: declined/abandoned stay portal-BROWSABLE, so
  // staff must still be able to pre-select on them (mirrors the customer
  // route's own row-236 carve-out).
  it.each(['declined', 'abandoned'] as const)(
    'ACCEPTS and persists a selection on a still-browsable %s quote',
    async (status) => {
      state.quote = { id: 'q1', customer_approved_at: null, deposit_paid_at: null, status };
      const res = await POST(makeReq(VALID_BODY), ctx());
      const json = await res.json();
      expect(res.status).toBe(200);
      expect(json.ok).toBe(true);
      expect(state.lastUpdatePayload).not.toBeNull();
    },
  );

  it('a null status (legacy row) still saves — fail-open, matching isPortalActionable', async () => {
    state.quote = { id: 'q1', customer_approved_at: null, deposit_paid_at: null, status: null };
    const res = await POST(makeReq(VALID_BODY), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it('saves a valid selection, guarded by .is(customer_approved_at, null) on the write, and stamps staffSet provenance', async () => {
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
        staffSet: { by: 'operator@example.com' },
      },
    });
    const staffSet = (state.lastUpdatePayload!.browsing_selection as Record<string, unknown>).staffSet as {
      by: string | null;
      at: string;
    };
    expect(typeof staffSet.at).toBe('string');
    expect(typeof state.lastUpdatePayload!.browsing_selection_updated_at).toBe('string');
  });

  it('stamps staffSet.by as null when getOperator returns null (dormant gate)', async () => {
    getOperatorMock.mockResolvedValueOnce(null);
    const res = await POST(makeReq(VALID_BODY), ctx());
    expect(res.status).toBe(200);
    const staffSet = (state.lastUpdatePayload!.browsing_selection as Record<string, unknown>).staffSet as {
      by: string | null;
    };
    expect(staffSet.by).toBeNull();
  });

  it('500s when the update fails', async () => {
    state.updateErr = { message: 'db exploded' };
    const res = await POST(makeReq(VALID_BODY), ctx());
    expect(res.status).toBe(500);
  });

  // Fix-round MED (technical + admin lenses): the pre-check above passed
  // (quote.customer_approved_at was null at fetch time), but a concurrent
  // approval landed before this write — the guarded `.is('customer_approved_at',
  // null)` then matches zero rows. Without the affected-rows check this used
  // to return {ok:true}, telling staff "Saved" when nothing was written.
  it('409s "locked" (never a silent ok:true) when the guarded write matches zero rows — a lost TOCTOU race', async () => {
    state.updatedRows = [];
    const res = await POST(makeReq(VALID_BODY), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('locked');
    expect(json.ok).toBeUndefined();
  });
});
