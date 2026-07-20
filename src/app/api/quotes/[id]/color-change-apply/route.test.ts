// Tests for POST /api/quotes/[id]/color-change-apply (ledger #163, staff apply
// half). Operator-gated. Apply re-freezes approval_snapshot.customerSelection to
// the pending request's colour (re-validated live) and notifies the customer;
// dismiss clears the marker and leaves the selection untouched. Either way a
// ZERO-DELTA amendment-trail entry is appended. The auth gate, Supabase,
// getAppSettings, and HighLevel send are mocked; colorSchemes.ts / amend.ts /
// agreedTotal.ts / resolveInstalls.ts run for real — the total-invariant + the
// re-validation behavior are what we verify.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_COLOR_SCHEMES, DEFAULT_BUILDABLE_COLOR_IDS } from '@/lib/design/colorSchemes';

const {
  sbRef,
  requireOperatorMock,
  getOperatorMock,
  sendSmsMock,
  sendEmailMock,
  isHlConfiguredMock,
  HighLevelErrorMock,
} = vi.hoisted(() => {
  class HighLevelErrorMock extends Error {}
  return {
    sbRef: { current: null as unknown },
    requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
    getOperatorMock: vi.fn(async (): Promise<unknown> => ({ name: 'naldo' })),
    sendSmsMock: vi.fn(async () => ({ ok: true })),
    sendEmailMock: vi.fn(async () => ({ ok: true })),
    isHlConfiguredMock: vi.fn(() => true),
    HighLevelErrorMock,
  };
});

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));
vi.mock('@/lib/appSettings', () => ({
  getAppSettings: async () => ({
    swatches: { schemes: DEFAULT_COLOR_SCHEMES, buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS },
    permanentSwatches: { schemes: DEFAULT_COLOR_SCHEMES, buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS },
  }),
}));
vi.mock('@/lib/integrations/highlevel', () => ({
  sendSms: sendSmsMock,
  sendEmail: sendEmailMock,
  isHighLevelConfigured: isHlConfiguredMock,
  HighLevelError: HighLevelErrorMock,
}));
// The route imports colorChangeLabel from the sibling request route, which
// itself imports rateLimit + the dashboard inbox store — neither is exercised
// here (only the pure label helper runs), so both are left real; they only
// touch the ALREADY-mocked '@/lib/supabase' at import time.

import { POST } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const HL_CONTACT = 'hl-1';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = (body: unknown) =>
  ({ json: async () => body, nextUrl: { origin: 'https://test.local' } }) as unknown as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

type Row = Record<string, unknown>;

// `single()` serves the initial load; the final `.update().eq().eq().select()`
// chain is awaited as a thenable (mirrors free-items/route.test.ts's harness).
function makeSb(quote: Row | null, updatedRows: unknown[] = [{ id: ID }]) {
  const updates: Row[] = [];
  const eqCalls: Array<[string, unknown]> = [];
  let updating = false;
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: () => b,
    select: () => b,
    update: (payload: Row) => {
      updating = true;
      updates.push(payload);
      return b;
    },
    eq: (column: string, value: unknown) => {
      eqCalls.push([column, value]);
      return b;
    },
    single: async () => ({ data: quote, error: quote ? null : { message: 'no rows' } }),
    then: (resolve: (v: unknown) => void) => {
      const value = updating ? { data: updatedRows, error: null } : { data: null, error: null };
      updating = false;
      resolve(value);
    },
  });
  return { client: b, updates, eqCalls };
}

function bookedQuote(overrides: Row = {}) {
  return {
    id: ID,
    customer_name: 'Test Person',
    customer_email: 'test@example.com',
    customer_phone: '+16315551212',
    highlevel_contact_id: HL_CONTACT,
    service_type: 'holiday',
    customer_approved_at: '2026-01-01T00:00:00Z',
    deposit_amount_usd: 1000,
    total: 2000,
    result: { total: 2000 },
    is_test: false,
    approval_snapshot: {
      customerSelection: { packageId: 'C', selectedItemIds: ['x'], currentTotalUsd: 2000 },
      amendments: [],
      pendingColorRequest: {
        colorSchemeId: 'multicolor',
        customPattern: [],
        colorIds: ['red', 'green', 'blue', 'yellow', 'pink'],
        label: 'Multicolor',
        requestedAt: '2026-01-05T00:00:00Z',
      },
    },
    ...overrides,
  } as Row;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue({ name: 'naldo' });
  isHlConfiguredMock.mockReturnValue(true);
  sbRef.current = null;
});

describe('POST /api/quotes/[id]/color-change-apply', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(401);
  });

  it('409s when there is no pending colour change request', async () => {
    const quote = bookedQuote({
      approval_snapshot: { customerSelection: { packageId: 'C', selectedItemIds: ['x'] }, amendments: [] },
    });
    sbRef.current = makeSb(quote).client;
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no-pending-request');
  });

  it('409s when the order is not booked', async () => {
    const quote = bookedQuote({
      customer_approved_at: null,
      approval_snapshot: {
        pendingColorRequest: {
          colorSchemeId: 'multicolor',
          customPattern: [],
          colorIds: null,
          label: 'Multicolor',
          requestedAt: '2026-01-05T00:00:00Z',
        },
      },
    });
    sbRef.current = makeSb(quote).client;
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('not-booked');
  });

  it('400s when dismissing without a note', async () => {
    sbRef.current = makeSb(bookedQuote()).client;
    const res = await POST(req({ action: 'dismiss' }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('note-required');
  });

  it(
    'applies the pending colour change: re-freezes the selection, clears the marker, appends a zero-delta ' +
      'trail entry (money invariant), and notifies the customer',
    async () => {
      const quote = bookedQuote();
      const { client, updates, eqCalls } = makeSb(quote);
      sbRef.current = client;

      const res = await POST(req({ action: 'apply', note: 'confirmed by phone' }), ctx());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        action: 'apply',
        label: 'Multicolor',
        colorSchemeId: 'multicolor',
        smsSent: true,
        emailSent: true,
      });

      expect(updates).toHaveLength(1);
      const payload = updates[0] as {
        approval_snapshot: {
          customerSelection: Record<string, unknown>;
          pendingColorRequest?: unknown;
          amendments: Array<{ delta: number; reason: string; new_total: number; previous_total: number }>;
        };
      };
      // marker cleared
      expect(payload.approval_snapshot.pendingColorRequest).toBeUndefined();
      // selection re-frozen to the (re-validated) requested colour
      expect(payload.approval_snapshot.customerSelection.colorSchemeId).toBe('multicolor');
      expect(payload.approval_snapshot.customerSelection.customPattern).toEqual([]);
      expect(payload.approval_snapshot.customerSelection.colorIds).toEqual([
        'red',
        'green',
        'blue',
        'yellow',
        'pink',
      ]);
      // money is byte-identical before/after — no total/result/deposit column touched at all
      expect(payload).not.toHaveProperty('total');
      expect(payload).not.toHaveProperty('result');
      expect(payload).not.toHaveProperty('deposit_amount_usd');
      expect(payload.approval_snapshot.customerSelection.currentTotalUsd).toBe(2000);
      // zero-delta audit entry
      expect(payload.approval_snapshot.amendments).toHaveLength(1);
      expect(payload.approval_snapshot.amendments[0].delta).toBe(0);
      expect(payload.approval_snapshot.amendments[0].new_total).toBe(2000);
      expect(payload.approval_snapshot.amendments[0].previous_total).toBe(2000);
      expect(payload.approval_snapshot.amendments[0].reason).toBe('Colour change applied: Multicolor — confirmed by phone');

      // CAS filter bound to the EXACT snapshot we read
      expect(eqCalls).toContainEqual(['approval_snapshot', JSON.stringify(quote.approval_snapshot)]);

      // customer notified (apply only)
      expect(sendSmsMock).toHaveBeenCalledTimes(1);
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
    },
  );

  it('re-validates the pending scheme against the CURRENT live list — a since-removed scheme falls back to as-designed rather than trusting stale stored ids', async () => {
    const quote = bookedQuote({
      approval_snapshot: {
        customerSelection: { packageId: 'C', selectedItemIds: ['x'], currentTotalUsd: 2000 },
        amendments: [],
        pendingColorRequest: {
          colorSchemeId: 'retired-scheme',
          customPattern: [],
          colorIds: ['red', 'green'], // stale — the scheme no longer exists on the live list
          label: 'Some Retired Scheme',
          requestedAt: '2026-01-05T00:00:00Z',
        },
      },
    });
    const { client, updates } = makeSb(quote);
    sbRef.current = client;

    const res = await POST(req({ action: 'apply' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.colorSchemeId).toBe('as-designed');

    const payload = updates[0] as {
      approval_snapshot: { customerSelection: { colorSchemeId: string; colorIds: string[] | null } };
    };
    expect(payload.approval_snapshot.customerSelection.colorSchemeId).toBe('as-designed');
    expect(payload.approval_snapshot.customerSelection.colorIds).toBeNull();
  });

  it('dismisses the pending request: clears the marker, leaves the selection untouched, appends a zero-delta trail entry, and does NOT notify', async () => {
    const quote = bookedQuote();
    const { client, updates } = makeSb(quote);
    sbRef.current = client;

    const res = await POST(req({ action: 'dismiss', note: 'customer changed their mind' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, action: 'dismiss', label: 'Multicolor', colorSchemeId: 'multicolor' });
    expect(body.smsSent).toBeUndefined();
    expect(body.emailSent).toBeUndefined();

    const payload = updates[0] as {
      approval_snapshot: {
        customerSelection: Record<string, unknown>;
        pendingColorRequest?: unknown;
        amendments: Array<{ delta: number; reason: string }>;
      };
    };
    expect(payload.approval_snapshot.pendingColorRequest).toBeUndefined();
    // the signed selection is UNTOUCHED
    expect(payload.approval_snapshot.customerSelection).toEqual(
      (quote.approval_snapshot as Row).customerSelection,
    );
    expect(payload.approval_snapshot.amendments).toHaveLength(1);
    expect(payload.approval_snapshot.amendments[0].delta).toBe(0);
    expect(payload.approval_snapshot.amendments[0].reason).toBe(
      'Colour change dismissed: Multicolor — customer changed their mind',
    );

    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('409s a CAS zero-rows loss instead of clobbering a concurrent edit', async () => {
    const quote = bookedQuote();
    const { client, updates, eqCalls } = makeSb(quote, []);
    sbRef.current = client;

    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('concurrent-edit');
    expect(updates).toHaveLength(1);
    expect(eqCalls).toContainEqual(['approval_snapshot', JSON.stringify(quote.approval_snapshot)]);
  });

  it('suppresses the customer notification for a Test Quote even on apply', async () => {
    const quote = bookedQuote({ is_test: true });
    sbRef.current = makeSb(quote).client;
    const res = await POST(req({ action: 'apply' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.smsSent).toBe(false);
    expect(body.emailSent).toBe(false);
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});
