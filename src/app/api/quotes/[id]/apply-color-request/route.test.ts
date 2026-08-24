// Tests for POST /api/quotes/[id]/apply-color-request (ledger #163 Slice B).
// Operator-gated. Staff APPLY (re-freeze the booked colour) or DISMISS a pending
// colour request. Supabase + auth + getAppSettings are mocked; amend.ts,
// agreedTotal, resolveColorChoice + the colour helpers run for real — the
// total-invariant + re-validation are what we verify.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';
import { DEFAULT_BUILDABLE_COLOR_IDS, DEFAULT_COLOR_SCHEMES } from '@/lib/design/colorSchemes';

const { sbRef, settingsRef, requireOperatorMock, getOperatorMock, sendSmsMock, sendEmailMock, hlConfiguredRef } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  settingsRef: { current: null as unknown },
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getOperatorMock: vi.fn(async (): Promise<unknown> => ({ name: 'naldo' })),
  sendSmsMock: vi.fn(async (): Promise<unknown> => ({})),
  sendEmailMock: vi.fn(async (): Promise<unknown> => ({})),
  // Default false so every pre-notify test runs exactly as before (no sends).
  hlConfiguredRef: { current: false },
}));

vi.mock('@/lib/integrations/highlevel', () => ({
  isHighLevelConfigured: () => hlConfiguredRef.current,
  sendSms: sendSmsMock,
  sendEmail: sendEmailMock,
  HighLevelError: class HighLevelError extends Error {},
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/auth/supabaseServer', () => ({
  requireOperator: requireOperatorMock,
  getOperator: getOperatorMock,
}));
vi.mock('@/lib/appSettings', () => ({
  getAppSettings: async () => settingsRef.current,
}));

import { POST } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const denied401 = () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
const req = (body: unknown) =>
  ({ json: async () => body, nextUrl: { origin: 'https://test.local' } }) as unknown as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

type Row = Record<string, unknown>;
function makeSb(
  quote: Row | null,
  fresh: Row | null = quote,
  quoteUpdateRows: Row[] = [{ id: ID }],
  // #208: opt-in knobs so a test can drive resolveInboxRequest's inbox_items
  // branch (every pre-existing test leaves inboxItem null, so the
  // maybeSingle() lookup keeps returning nothing and resolveInboxRequest
  // short-circuits before ever reaching these — unchanged behavior for them).
  inboxOpts: { inboxItem?: Row | null; inboxUpdateError?: { message: string } | null } = {},
) {
  const { inboxItem = null, inboxUpdateError = null } = inboxOpts;
  const updates: { quotes: Row[]; inbox_items: Row[] } = { quotes: [], inbox_items: [] };
  const activityInserts: Row[] = [];
  const eqCalls: Array<[string, unknown]> = [];
  let table = '';
  let updating = false;
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: (t: string) => {
      table = t;
      return b;
    },
    select: () => b,
    update: (payload: Row) => {
      updating = true;
      (updates as Record<string, Row[]>)[table]?.push(payload);
      return b;
    },
    insert: (payload: Row) => {
      if (table === 'dashboard_activity') activityInserts.push(payload);
      return b;
    },
    eq: (col: string, val: unknown) => {
      eqCalls.push([col, val]);
      return b;
    },
    single: async () => ({ data: quote, error: quote ? null : { message: 'no rows' } }),
    maybeSingle: async () => (table === 'inbox_items' ? { data: inboxItem, error: null } : { data: fresh, error: null }),
    // Models the CAS write: a quotes UPDATE resolves to the rows that matched the
    // .eq('approval_snapshot', ...) filter — [] simulates a lost concurrency race.
    // An inbox_items UPDATE (resolveInboxRequest) resolves per inboxUpdateError.
    then: (resolve: (v: unknown) => void) => {
      let data: unknown = null;
      let error: unknown = null;
      if (updating && table === 'quotes') {
        data = quoteUpdateRows;
      } else if (updating && table === 'inbox_items') {
        error = inboxUpdateError;
        data = inboxUpdateError ? null : [{ id: (inboxItem as Row | null)?.id }];
      }
      updating = false;
      resolve({ data, error });
    },
  });
  return { client: b, updates, eqCalls, activityInserts };
}

function bookedQuote(overrides: Row = {}, pending: Row | null = {
  colorSchemeId: 'custom',
  customPattern: ['red', 'green'],
  colorIds: ['red', 'green'],
  label: 'Custom pattern (2 colours)',
}) {
  const snapshot: Row = {
    customerSelection: {
      packageId: 'C',
      selectedItemIds: ['x'],
      colorSchemeId: 'as-designed',
      customPattern: [],
      colorIds: null,
      currentTotalUsd: 2000,
    },
    amendments: [],
    ...(pending ? { pendingColorRequest: pending } : {}),
  };
  return {
    id: ID,
    status: 'booked',
    customer_approved_at: '2026-01-01T00:00:00Z',
    deposit_paid_at: '2026-01-02T00:00:00Z',
    deposit_amount_usd: 1000,
    total: 2000,
    result: { total: 2000 },
    service_type: 'holiday',
    approval_snapshot: snapshot,
    ...overrides,
  } as Row;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  getOperatorMock.mockResolvedValue({ name: 'naldo' });
  sbRef.current = null;
  settingsRef.current = {
    swatches: { schemes: DEFAULT_COLOR_SCHEMES, buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS },
    permanentSwatches: { schemes: DEFAULT_COLOR_SCHEMES, buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS },
  };
  hlConfiguredRef.current = false;
});

describe('POST /api/quotes/[id]/apply-color-request', () => {
  it('401s when the operator gate denies', async () => {
    requireOperatorMock.mockResolvedValueOnce(denied401());
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(401);
  });

  it('409s when there is no pending colour request', async () => {
    sbRef.current = makeSb(bookedQuote({}, null)).client;
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(409);
  });

  it('400s a dismiss with no reason', async () => {
    sbRef.current = makeSb(bookedQuote()).client;
    const res = await POST(req({ action: 'dismiss' }), ctx());
    expect(res.status).toBe(400);
  });

  it('dismiss clears the pending request', async () => {
    const { client, updates } = makeSb(bookedQuote());
    sbRef.current = client;
    const res = await POST(req({ action: 'dismiss', reason: 'we already discussed by phone' }), ctx());
    expect(res.status).toBe(200);
    const snap = updates.quotes[0].approval_snapshot as Row;
    expect(snap.pendingColorRequest).toBeUndefined();
    expect(snap.customerSelection).toBeDefined(); // selection untouched
  });

  it('apply re-freezes the colour, clears pending, records a ZERO-delta amendment, total invariant', async () => {
    const { client, updates } = makeSb(bookedQuote());
    sbRef.current = client;
    const res = await POST(req({ action: 'apply' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);

    const snap = updates.quotes[0].approval_snapshot as {
      customerSelection: { colorSchemeId: string; customPattern: string[]; currentTotalUsd: number };
      pendingColorRequest?: unknown;
      amendments: Array<{ delta: number }>;
    };
    // re-frozen onto the signed selection
    expect(snap.customerSelection.colorSchemeId).toBe('custom');
    expect(snap.customerSelection.customPattern).toEqual(['red', 'green']);
    // pending cleared
    expect(snap.pendingColorRequest).toBeUndefined();
    // zero-delta amendment appended
    expect(snap.amendments).toHaveLength(1);
    expect(snap.amendments[0].delta).toBe(0);
    // money invariant: the agreed total is untouched
    expect(snap.customerSelection.currentTotalUsd).toBe(2000);
  });

  it('apply RE-VALIDATES against the live swatch list — an unknown scheme degrades to as-designed', async () => {
    const { client, updates } = makeSb(
      bookedQuote({}, { colorSchemeId: 'scheme-deleted-since', customPattern: [], colorIds: ['x'], label: 'Gone' }),
    );
    sbRef.current = client;
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(200);
    const snap = updates.quotes[0].approval_snapshot as {
      customerSelection: { colorSchemeId: string; customPattern: string[] };
    };
    expect(snap.customerSelection.colorSchemeId).toBe('as-designed');
    expect(snap.customerSelection.customPattern).toEqual([]);
  });

  it('uses the live Permanent scheme label in the amendment and response', async () => {
    hlConfiguredRef.current = true;
    const permanentScheme = { id: 'permanent-ocean', label: 'Ocean Twinkle', colorIds: ['blue'] };
    settingsRef.current = {
      swatches: { schemes: DEFAULT_COLOR_SCHEMES, buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS },
      permanentSwatches: {
        schemes: [DEFAULT_COLOR_SCHEMES[0], permanentScheme],
        buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS,
      },
    };
    const { client, updates } = makeSb(
      bookedQuote(
        {
          service_type: 'permanent',
          customer_name: 'Jordan Smith',
          highlevel_contact_id: 'hl-1',
          is_test: false,
        },
        { colorSchemeId: permanentScheme.id, customPattern: [], colorIds: ['blue'], label: 'stale label' },
      ),
    );
    sbRef.current = client;

    const res = await POST(req({ action: 'apply' }), ctx());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.label).toBe('Ocean Twinkle');
    const snapshot = updates.quotes[0].approval_snapshot as {
      customerSelection: { colorSchemeId: string; colorIds: string[] };
      amendments: Array<{ reason: string }>;
    };
    expect(snapshot.customerSelection).toMatchObject({
      colorSchemeId: permanentScheme.id,
      colorIds: ['blue'],
    });
    expect(snapshot.amendments[0].reason).toContain('Ocean Twinkle');
    const [sms] = (sendSmsMock.mock.calls as unknown as Array<[{ message: string }]>)[0];
    const [email] = (sendEmailMock.mock.calls as unknown as Array<[{ html: string }]>)[0];
    expect(sms.message).toContain('Ocean Twinkle');
    expect(email.html).toContain('Ocean Twinkle');
  });

  it('does not change the existing Holiday label behavior in this Permanent-only fix', async () => {
    const renamedHolidayScheme = {
      ...DEFAULT_COLOR_SCHEMES.find((scheme) => scheme.id === 'warm-white')!,
      label: 'Settings Ivory',
    };
    settingsRef.current = {
      swatches: {
        schemes: [DEFAULT_COLOR_SCHEMES[0], renamedHolidayScheme],
        buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS,
      },
      permanentSwatches: { schemes: DEFAULT_COLOR_SCHEMES, buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS },
    };
    const { client } = makeSb(
      bookedQuote(
        { service_type: 'holiday' },
        { colorSchemeId: 'warm-white', customPattern: [], colorIds: ['warm-white'], label: 'stale label' },
      ),
    );
    sbRef.current = client;

    const res = await POST(req({ action: 'apply' }), ctx());

    expect(res.status).toBe(200);
    expect((await res.json()).label).toBe('Warm White');
  });

  it('409s when the order is terminal (cancelled)', async () => {
    sbRef.current = makeSb(bookedQuote({ status: 'cancelled' })).client;
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(409);
  });

  // ── the #163 CAS-race fixes ────────────────────────────────────────────────
  it('APPLY 409s (concurrent-edit) when the CAS write matches no rows — never clobbers a racing amend', async () => {
    const q = bookedQuote();
    const { client, updates } = makeSb(q, q, []); // [] = the CAS lost the race
    sbRef.current = client;
    const res = await POST(req({ action: 'apply' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('concurrent-edit');
    // it attempted a CAS write but the row it targeted did not change on our terms
    expect(updates.quotes.length).toBe(1);
  });

  it('DISMISS 409s (concurrent-edit) when the CAS write matches no rows', async () => {
    const q = bookedQuote();
    const { client } = makeSb(q, q, []);
    sbRef.current = client;
    const res = await POST(req({ action: 'dismiss', reason: 'phone call' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('concurrent-edit');
  });

  it('DISMISS is ALLOWED on a terminal (cancelled) order — clears the stranded marker', async () => {
    const { client, updates } = makeSb(bookedQuote({ status: 'cancelled' }));
    sbRef.current = client;
    const res = await POST(req({ action: 'dismiss', reason: 'order was cancelled' }), ctx());
    expect(res.status).toBe(200);
    const snap = updates.quotes[0].approval_snapshot as Row;
    expect(snap.pendingColorRequest).toBeUndefined();
  });

  it('APPLY labels the ACTUALLY-frozen colour, not the stale request label, after a re-validation degrade', async () => {
    const { client, updates } = makeSb(
      bookedQuote({}, { colorSchemeId: 'scheme-deleted-since', customPattern: [], colorIds: ['x'], label: 'Gone' }),
    );
    sbRef.current = client;
    const res = await POST(req({ action: 'apply' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.label).not.toBe('Gone'); // not the stale request-time label
    const snap = updates.quotes[0].approval_snapshot as { amendments: Array<{ reason: string }> };
    expect(snap.amendments[0].reason).not.toContain('Gone');
  });

  it('APPLY compare-and-swaps on the ORIGINAL snapshot — a colour-resubmit/amend after read trips 409, never a stale freeze', async () => {
    const q = bookedQuote();
    const { client, eqCalls } = makeSb(q);
    sbRef.current = client;
    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(200);
    // The CAS filter compares against the snapshot we READ + derived the colour
    // from — not a later re-read — so any concurrent pending change fails the swap
    // rather than letting a stale colour be frozen.
    const casValues = eqCalls.filter(([c]) => c === 'approval_snapshot').map(([, v]) => v);
    expect(casValues).toContain(JSON.stringify(q.approval_snapshot));
  });

  // ── #163 notify-on-apply (owner decision: apply notifies, dismiss is silent) ─
  it('APPLY notifies the customer by SMS + email on a real quote', async () => {
    hlConfiguredRef.current = true;
    const { client } = makeSb(
      bookedQuote({ customer_name: 'Jordan Smith', highlevel_contact_id: 'hl-1', is_test: false }),
    );
    sbRef.current = client;
    const res = await POST(req({ action: 'apply' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.smsSent).toBe(true);
    expect(body.emailSent).toBe(true);
    expect(body.notifySkipped).toBe(false); // #169: attempted, not skipped
    expect(sendSmsMock).toHaveBeenCalledOnce();
    expect(sendEmailMock).toHaveBeenCalledOnce();
    const [sms] = (sendSmsMock.mock.calls as unknown as Array<[{ contactId: string; message: string }]>)[0];
    expect(sms.contactId).toBe('hl-1');
    expect(sms.message).toContain('confirmed');
  });

  it('APPLY notify is SUPPRESSED for a Test Quote (#93)', async () => {
    hlConfiguredRef.current = true;
    const { client } = makeSb(
      bookedQuote({ customer_name: 'Jordan Smith', highlevel_contact_id: 'hl-1', is_test: true }),
    );
    sbRef.current = client;
    const res = await POST(req({ action: 'apply' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.notifySkipped).toBe(true); // #169: the panel shows "expected", not a failure
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('a notify failure never fails the apply (best-effort)', async () => {
    hlConfiguredRef.current = true;
    sendSmsMock.mockRejectedValueOnce(new Error('HL down'));
    sendEmailMock.mockRejectedValueOnce(new Error('HL down'));
    const { client, updates } = makeSb(
      bookedQuote({ customer_name: 'Jordan Smith', highlevel_contact_id: 'hl-1', is_test: false }),
    );
    sbRef.current = client;
    const res = await POST(req({ action: 'apply' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.smsSent).toBe(false);
    expect(body.emailSent).toBe(false);
    expect(body.notifySkipped).toBe(false); // #169: attempted-and-FAILED → the panel says "call them"
    // the colour was still applied
    const snap = updates.quotes[0].approval_snapshot as { pendingColorRequest?: unknown };
    expect(snap.pendingColorRequest).toBeUndefined();
  });

  it('DISMISS never notifies the customer', async () => {
    hlConfiguredRef.current = true;
    const { client } = makeSb(
      bookedQuote({ customer_name: 'Jordan Smith', highlevel_contact_id: 'hl-1', is_test: false }),
    );
    sbRef.current = client;
    const res = await POST(req({ action: 'dismiss', reason: 'discussed by phone' }), ctx());
    expect(res.status).toBe(200);
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

// #208: resolveInboxRequest was writing the `by` DISPLAY STRING (e.g.
// 'staff:naldo') into inbox_items.handled_by, a `uuid references
// auth.users(id)` column — Postgres rejects non-uuid text, so the WHOLE
// update (status/handled_at too) silently failed on every real call, and the
// error was never checked. These tests exercise resolveInboxRequest's actual
// DB write (the pre-existing suite above never does: its `makeSb` always
// leaves the inbox_items lookup empty, so resolveInboxRequest short-circuits
// before reaching the update at all).
describe('POST /api/quotes/[id]/apply-color-request — resolveInboxRequest handled_by (#208)', () => {
  const INBOX_ITEM = { id: 'inbox-item-1' };

  it('APPLY stamps the real operator uuid onto handled_by — never the "staff:name" display string', async () => {
    getOperatorMock.mockResolvedValueOnce({ id: 'op-uuid-123', name: 'naldo', email: 'naldo@yulelovelights.com' });
    const { client, updates, activityInserts } = makeSb(bookedQuote(), undefined, undefined, {
      inboxItem: INBOX_ITEM,
    });
    sbRef.current = client;

    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(200);

    expect(updates.inbox_items).toHaveLength(1);
    expect(updates.inbox_items[0]).toMatchObject({ status: 'completed', handled_by: 'op-uuid-123' });
    expect(updates.inbox_items[0].handled_by).not.toContain('staff:');
    expect(activityInserts[0]).toMatchObject({ actor: 'op-uuid-123', action: 'completed' });
  });

  it('DISMISS stamps the real operator uuid onto handled_by — never the "staff:name" display string', async () => {
    getOperatorMock.mockResolvedValueOnce({ id: 'op-uuid-456', name: 'jason', email: 'jason@yulelovelights.com' });
    const { client, updates } = makeSb(bookedQuote(), undefined, undefined, { inboxItem: INBOX_ITEM });
    sbRef.current = client;

    const res = await POST(req({ action: 'dismiss', reason: 'discussed by phone' }), ctx());
    expect(res.status).toBe(200);

    expect(updates.inbox_items[0]).toMatchObject({ status: 'completed', handled_by: 'op-uuid-456' });
  });

  it('writes NULL (never a sentinel string) to handled_by when no operator resolves', async () => {
    getOperatorMock.mockResolvedValueOnce(null);
    const { client, updates } = makeSb(bookedQuote(), undefined, undefined, { inboxItem: INBOX_ITEM });
    sbRef.current = client;

    const res = await POST(req({ action: 'apply' }), ctx());
    expect(res.status).toBe(200);

    expect(updates.inbox_items[0].handled_by).toBeNull();
  });

  it('logs (does not swallow) an inbox_items update failure, and still 200s the request (best-effort)', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      getOperatorMock.mockResolvedValueOnce({ id: 'op-uuid-123', name: 'naldo' });
      const { client, activityInserts } = makeSb(bookedQuote(), undefined, undefined, {
        inboxItem: INBOX_ITEM,
        inboxUpdateError: { message: 'invalid input syntax for type uuid' },
      });
      sbRef.current = client;

      const res = await POST(req({ action: 'apply' }), ctx());
      expect(res.status).toBe(200); // the quote-level apply still succeeds — inbox resolve is best-effort
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        '[api/quotes/:id/apply-color-request] inbox item resolve failed (non-fatal):',
        'invalid input syntax for type uuid',
      );
      // Never claims "completed" in the activity log when the item update didn't land.
      expect(activityInserts).toHaveLength(0);
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });
});
