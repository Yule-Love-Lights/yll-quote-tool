// Tests for POST /api/quotes/[id]/color-change-request (ledger #163 + row 319).
// A booked customer requests a colour change; the route sanitizes the colour,
// records it on the quote (approval_snapshot.pendingColorRequest), pings the
// inbox, AND (row 319) fires a best-effort internal staff email so the request
// is never visible only in /inbox. It does NOT alter the booked order. Supabase
// + getAppSettings + ingestTouch + HighLevel sendEmail are mocked; the colour
// sanitize helpers run for real.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { type NextRequest } from 'next/server';
import { DEFAULT_COLOR_SCHEMES, DEFAULT_BUILDABLE_COLOR_IDS } from '@/lib/design/colorSchemes';

const { sbRef, ingestTouchMock, hl } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  ingestTouchMock: vi.fn(async (_touch: unknown, _now: unknown) => ({ ok: true })),
  hl: {
    configured: { value: true },
    sendEmail: vi.fn(async (_args: { subject: string; html: string; contactId: string }) => ({})),
  },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));
vi.mock('@/lib/appSettings', () => ({
  getAppSettings: async () => ({
    swatches: { schemes: DEFAULT_COLOR_SCHEMES, buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS },
    permanentSwatches: { schemes: DEFAULT_COLOR_SCHEMES, buildableColorIds: DEFAULT_BUILDABLE_COLOR_IDS },
  }),
}));
vi.mock('@/lib/dashboard/inbox/store', () => ({ ingestTouch: ingestTouchMock }));
vi.mock('@/lib/integrations/highlevel', () => ({
  isHighLevelConfigured: () => hl.configured.value,
  sendEmail: hl.sendEmail,
  HighLevelError: class HighLevelError extends Error {},
}));

import { POST, colorChangeLabel } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const req = (body: unknown) =>
  ({ json: async () => body, nextUrl: { origin: 'https://test.local' } }) as unknown as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

type Row = Record<string, unknown>;
function makeSb(quote: Row | null, fresh: Row | null = quote, quoteUpdateRows: Row[] = [{ id: ID }]) {
  const updates: Row[] = [];
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
      updates.push(payload);
      return b;
    },
    eq: () => b,
    single: async () => ({ data: quote, error: quote ? null : { message: 'no rows' } }),
    maybeSingle: async () => ({ data: fresh, error: null }),
    // Models the CAS write: a quotes UPDATE resolves to the rows that matched the
    // .eq('approval_snapshot', ...) filter — [] simulates a lost concurrency race.
    then: (resolve: (v: unknown) => void) => {
      const data = updating && table === 'quotes' ? quoteUpdateRows : null;
      updating = false;
      resolve({ data, error: null });
    },
  });
  return { client: b, updates };
}

function bookedQuote(overrides: Row = {}) {
  return {
    id: ID,
    customer_name: 'Test Person',
    customer_email: 'test@example.com',
    customer_phone: '+16315551212',
    customer_address: '1 Main St',
    service_type: 'holiday',
    highlevel_contact_id: 'hl-1',
    customer_approved_at: '2026-01-01T00:00:00Z',
    deposit_paid_at: '2026-01-02T00:00:00Z',
    quote_sent_at: '2025-12-01T00:00:00Z',
    status: 'booked',
    total: 2000,
    approval_snapshot: { customerSelection: { packageId: 'C', selectedItemIds: ['x'] } },
    ...overrides,
  } as Row;
}

beforeEach(() => {
  vi.clearAllMocks();
  sbRef.current = null;
  hl.configured.value = true;
  delete process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
});

describe('colorChangeLabel', () => {
  it('labels a custom pattern by its colour count', () => {
    expect(colorChangeLabel('custom', ['red', 'green'])).toBe('Custom pattern (2 colours)');
    expect(colorChangeLabel('custom', ['red'])).toBe('Custom pattern (1 colour)');
  });

  it('labels a preset scheme with its display name', () => {
    expect(typeof colorChangeLabel('as-designed', [])).toBe('string');
    expect(colorChangeLabel('as-designed', []).length).toBeGreaterThan(0);
  });
});

describe('POST /api/quotes/[id]/color-change-request', () => {
  it('409s when the order is not booked (no approval snapshot)', async () => {
    sbRef.current = makeSb(
      bookedQuote({ customer_approved_at: null, approval_snapshot: null }),
    ).client;
    const res = await POST(req({ colorSchemeId: 'as-designed' }), ctx());
    expect(res.status).toBe(409);
  });

  it('records the requested colour on the quote and pings the inbox', async () => {
    const { client, updates } = makeSb(bookedQuote());
    sbRef.current = client;

    const res = await POST(req({ colorSchemeId: 'custom', customPattern: ['red', 'green'] }), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.label).toBe('Custom pattern (2 colours)');

    // pendingColorRequest recorded; the signed customerSelection is untouched.
    expect(updates).toHaveLength(1);
    const snap = (updates[0].approval_snapshot as {
      customerSelection: unknown;
      pendingColorRequest: { colorSchemeId: string; customPattern: string[]; label: string };
    });
    expect(snap.customerSelection).toEqual({ packageId: 'C', selectedItemIds: ['x'] });
    expect(snap.pendingColorRequest.colorSchemeId).toBe('custom');
    expect(snap.pendingColorRequest.customPattern).toEqual(['red', 'green']);
    expect(snap.pendingColorRequest.label).toBe('Custom pattern (2 colours)');

    // inbox notified with a distinct external_id (never collides with quote-sent).
    expect(ingestTouchMock).toHaveBeenCalledTimes(1);
    const touch = ingestTouchMock.mock.calls[0][0] as { source: string; externalId: string };
    expect(touch.source).toBe('quotetool');
    expect(touch.externalId).toBe(`${ID}:color-request`);
  });

  it('still succeeds (request saved) when the inbox ping throws', async () => {
    ingestTouchMock.mockRejectedValueOnce(new Error('inbox down'));
    const { client, updates } = makeSb(bookedQuote());
    sbRef.current = client;
    const res = await POST(req({ colorSchemeId: 'as-designed' }), ctx());
    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1); // the request was still recorded
  });

  // ── the #163 CAS-race + terminal fixes ─────────────────────────────────────
  it('409s (concurrent-edit) when the CAS write matches no rows — never clobbers a racing amend', async () => {
    const q = bookedQuote();
    const { client } = makeSb(q, q, []); // [] = the CAS lost the race to a concurrent write
    sbRef.current = client;
    const res = await POST(req({ colorSchemeId: 'as-designed' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('concurrent-edit');
    // inbox is NOT pinged when the request did not persist
    expect(ingestTouchMock).not.toHaveBeenCalled();
  });

  it('409s (not-editable) on a terminal order — a cancelled order takes no colour requests', async () => {
    sbRef.current = makeSb(bookedQuote({ status: 'cancelled' })).client;
    const res = await POST(req({ colorSchemeId: 'as-designed' }), ctx());
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.code).toBe('not-editable');
  });

  // ── row 319: immediate internal staff email ────────────────────────────────
  describe('internal staff email (row 319)', () => {
    it('fires a best-effort staff email naming the customer + requested colour on success', async () => {
      process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
      sbRef.current = makeSb(bookedQuote()).client;

      const res = await POST(req({ colorSchemeId: 'custom', customPattern: ['red', 'green'] }), ctx());
      expect(res.status).toBe(200);
      expect(hl.sendEmail).toHaveBeenCalledTimes(1);
      const call = hl.sendEmail.mock.calls[0][0];
      expect(call.contactId).toBe('internal-1');
      expect(call.subject).toContain('Test Person');
      expect(call.subject.toLowerCase()).toContain('colour change requested');
      expect(call.html).toContain('Test Person');
      expect(call.html).toContain('Custom pattern (2 colours)');
      // Links to the admin quote detail page — the only page ColorRequestPanel
      // (the actual apply/dismiss UI) renders on. The general quote builder
      // (/quote/<id>) has no awareness of pendingColorRequest at all.
      expect(call.html).toContain(`/admin/quotes/${ID}`);
    });

    it('does NOT fire the email on a validation failure (order not booked)', async () => {
      process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
      sbRef.current = makeSb(
        bookedQuote({ customer_approved_at: null, approval_snapshot: null }),
      ).client;

      const res = await POST(req({ colorSchemeId: 'as-designed' }), ctx());
      expect(res.status).toBe(409);
      expect(hl.sendEmail).not.toHaveBeenCalled();
    });

    it('does NOT fire the email when the CAS write loses the race (request never persisted)', async () => {
      process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
      const q = bookedQuote();
      sbRef.current = makeSb(q, q, []).client;

      const res = await POST(req({ colorSchemeId: 'as-designed' }), ctx());
      expect(res.status).toBe(409);
      expect(hl.sendEmail).not.toHaveBeenCalled();
    });

    it('still 200s (request saved) when the staff email throws', async () => {
      process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
      hl.sendEmail.mockRejectedValueOnce(new Error('GHL down'));
      const { client, updates } = makeSb(bookedQuote());
      sbRef.current = client;

      const res = await POST(req({ colorSchemeId: 'as-designed' }), ctx());
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(updates).toHaveLength(1); // the request was still recorded
    });

    it('skips the email (no throw) when HighLevel is not configured', async () => {
      hl.configured.value = false;
      process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
      sbRef.current = makeSb(bookedQuote()).client;

      const res = await POST(req({ colorSchemeId: 'as-designed' }), ctx());
      expect(res.status).toBe(200);
      expect(hl.sendEmail).not.toHaveBeenCalled();
    });
  });
});
