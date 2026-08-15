// Tests for POST /api/quotes/[id]/view (#68 customer-viewed read receipt).
// The route records a customer opening /portal/[id] and emails staff. It must
// distinguish a STAFF preview from an actual CUSTOMER open: since #81, a logged-in
// operator carries a Supabase session (getOperator() != null) while a customer has
// none. A staff view is skipped entirely — no DB write, no event row, no email —
// so the view_count / activity feed / staff notification only reflect real customers.
//
// Supabase, HighLevel, and getOperator mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { sbRef, hl, op } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  hl: {
    configured: { value: true },
    sendEmail: vi.fn(async () => ({})),
  },
  // The operator getOperator() resolves to: null = a customer, an object = staff.
  op: { current: null as unknown },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: () => null }));

vi.mock('@/lib/integrations/highlevel', () => ({
  isHighLevelConfigured: () => hl.configured.value,
  sendEmail: hl.sendEmail,
  HighLevelError: class HighLevelError extends Error {},
}));

vi.mock('@/lib/auth/supabaseServer', () => ({
  getOperator: async () => op.current,
}));

import { POST } from './route';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function baseQuote(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    customer_name: 'Jordan Smith',
    customer_address: '1 Main St',
    customer_phone: '+15555550123',
    customer_email: 'jordan@example.com',
    highlevel_contact_id: null,
    quote_sent_at: '2026-06-25T00:00:00Z',
    viewed_at: null,
    view_count: 0,
    // #262 — the persisted lifecycle status. A normal freshly-sent quote is
    // 'sent'; individual tests override this to exercise the status-advance
    // guard (approved/booked/declined/viewed/null must all be left alone).
    status: 'sent',
    ...overrides,
  };
}

// Models the view route's awaited writes: `.update().eq()...` (the stamp,
// and — #262 — a second, separate `.update().eq().eq()` for the status
// CAS), `.insert()` (the event-log row), plus the `.select().eq().single()`
// fetch. Each update() call is recorded with its OWN `.eq()` args (in call
// order) so a test can assert the status write carried the `status='sent'`
// CAS filter, distinct from the unconditional stamp write.
function makeSb(
  quote: Record<string, unknown> | null,
  opts: {
    stampError?: { message: string } | null;
    statusUpdateError?: { message: string } | null;
    eventError?: { message: string } | null;
  } = {},
) {
  const updates: Array<{ payload: Record<string, unknown>; eqCalls: Array<[string, unknown]> }> = [];
  const insertPayloads: Array<Record<string, unknown>> = [];
  const builder: Record<string, unknown> = {};
  let mode: 'update' | 'insert' | null = null;
  let updateCount = 0;
  let pendingEqCalls: Array<[string, unknown]> = [];
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    eq: (col: string, val: unknown) => {
      pendingEqCalls.push([col, val]);
      return builder;
    },
    single: async () => ({ data: quote, error: quote ? null : { message: 'no row' } }),
    update: (payload: Record<string, unknown>) => {
      mode = 'update';
      pendingEqCalls = [];
      updates.push({ payload, eqCalls: pendingEqCalls });
      return builder;
    },
    insert: (payload: Record<string, unknown>) => {
      mode = 'insert';
      insertPayloads.push(payload);
      return builder;
    },
    then: (resolve: (v: unknown) => void) => {
      let res: { error: { message: string } | null };
      if (mode === 'update') {
        updateCount += 1;
        // 1st update() = the stamp (viewed_at/last_viewed_at/view_count);
        // 2nd = the #262 status CAS. Each gets its own error control.
        res = { error: (updateCount === 1 ? opts.stampError : opts.statusUpdateError) ?? null };
      } else if (mode === 'insert') {
        res = { error: opts.eventError ?? null };
      } else {
        res = { error: null };
      }
      mode = null;
      resolve(res);
    },
  });
  return { client: builder, updates, insertPayloads };
}

function makeReq(opts: { staffCookie?: boolean } = {}): NextRequest {
  return {
    json: async () => ({}),
    headers: { get: () => null },
    nextUrl: { origin: 'https://quote.example.com' },
    cookies: {
      get: (name: string) =>
        opts.staffCookie && name === 'yll_staff_device' ? { value: '1' } : undefined,
    },
  } as unknown as NextRequest;
}
const params = Promise.resolve({ id: ID });

beforeEach(() => {
  vi.clearAllMocks();
  hl.configured.value = false;
  op.current = null;
  delete process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
});

describe('POST /api/quotes/[id]/view — customer view (no operator session)', () => {
  it('records the view on a sent quote — stamps + advances status + appends an event row', async () => {
    const { client, updates, insertPayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.viewCount).toBe(1);
    // #262: two separate update() calls — the unconditional stamp, then the
    // CAS-guarded status advance.
    expect(updates).toHaveLength(2);
    expect(updates[0].payload.view_count).toBe(1);
    expect(updates[0].payload.last_viewed_at).toBeTruthy();
    expect(updates[1].payload.status).toBe('viewed');
    expect(updates[1].eqCalls).toContainEqual(['status', 'sent']);
    expect(insertPayloads).toHaveLength(1);
    expect(insertPayloads[0].quote_id).toBe(ID);
  });

  it('emails staff when HighLevel is configured', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    expect(res.status).toBe(200);
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('skips an unsent quote (no-op) — not a customer view yet', async () => {
    const { client, updates } = makeSb(baseQuote({ quote_sent_at: null }));
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.skipped).toBe('not-sent');
    expect(updates).toHaveLength(0);
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('rejects a bad UUID → 400', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;
    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/quotes/[id]/view — staff view (operator session present)', () => {
  it('is skipped: no DB write, no event row, no staff email', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    op.current = { id: 'op-1', email: 'staff@yulelovelights.com', role: 'operator', name: 'Sam' };
    const { client, updates, insertPayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.skipped).toBe('staff');
    expect(updates).toHaveLength(0);
    expect(insertPayloads).toHaveLength(0);
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('an admin operator is also treated as staff', async () => {
    op.current = { id: 'op-2', email: 'admin@yulelovelights.com', role: 'admin', name: 'Admin' };
    const { client, updates } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();
    expect(json.skipped).toBe('staff');
    expect(updates).toHaveLength(0);
  });
});

describe('POST /api/quotes/[id]/view — staff view (device cookie, NO operator session)', () => {
  it('the staff-device cookie alone skips the view — the dormant-auth case (S22)', async () => {
    // op.current stays null: no operator session (auth gate dormant). The cookie
    // is the only staff signal — it must still skip the DB write + event + email.
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    const { client, updates, insertPayloads } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq({ staffCookie: true }), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.skipped).toBe('staff');
    expect(updates).toHaveLength(0);
    expect(insertPayloads).toHaveLength(0);
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });
});

// Ledger #262: /view stamped viewed_at but never advanced the PERSISTED
// `status` column, so a row could sit at status='sent' with viewed_at set —
// any surface reading `status` directly (not through deriveStatus()) showed
// "Sent" for a quote the customer demonstrably opened. Fixed by a CAS-guarded
// second update (`status: 'viewed'` WHERE `status = 'sent'`), separate from
// the unconditional stamp above so repeat-view tracking on an
// approved/booked/declined/already-viewed quote is untouched.
describe('POST /api/quotes/[id]/view — #262 status advance (persisted status sent → viewed)', () => {
  it('advances status sent → viewed on a first view (fresh quote, viewed_at not yet set)', async () => {
    const { client, updates } = makeSb(baseQuote({ status: 'sent', viewed_at: null }));
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.viewedAt).toBeTruthy();
    expect(updates).toHaveLength(2);
    expect(updates[1].payload.status).toBe('viewed');
    expect(updates[1].eqCalls).toContainEqual(['id', ID]);
    expect(updates[1].eqCalls).toContainEqual(['status', 'sent']);
  });

  // THE SUBTLE CASE (ledger #262's 19 drifted prod rows): status is still
  // 'sent' but viewed_at was ALREADY stamped by an earlier view (from before
  // this fix shipped). The stamp update's `viewed_at: quote.viewed_at ?? now`
  // short-circuits and leaves viewed_at UNCHANGED on this call — the status
  // CAS must not depend on that branch or a drifted row could never heal.
  // It's a separate update keyed only off the row's persisted `status`, so it
  // fires and heals the row regardless of the viewed_at short-circuit.
  it('heals a DRIFTED row (status=sent, viewed_at already set) on the next view', async () => {
    const staleViewedAt = '2026-07-01T12:00:00Z';
    const { client, updates } = makeSb(
      baseQuote({ status: 'sent', viewed_at: staleViewedAt, view_count: 3 }),
    );
    sbRef.current = client;

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    // viewed_at semantics are UNCHANGED by this fix — still the first-open
    // timestamp, not touched by a later view.
    expect(json.viewedAt).toBe(staleViewedAt);
    expect(updates[0].payload.viewed_at).toBe(staleViewedAt);
    expect(updates[0].payload.view_count).toBe(4);
    // ...but the status CAS still fires and heals the drifted column.
    expect(updates).toHaveLength(2);
    expect(updates[1].payload.status).toBe('viewed');
    expect(updates[1].eqCalls).toContainEqual(['status', 'sent']);
  });

  it('repeat view on an already-"viewed" quote is idempotent — no status write attempted', async () => {
    const { client, updates } = makeSb(
      baseQuote({ status: 'viewed', viewed_at: '2026-07-01T12:00:00Z', view_count: 1 }),
    );
    sbRef.current = client;

    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(200);
    // Only the unconditional stamp fires; the status CAS is never attempted
    // because quote.status !== 'sent' — status is left byte-untouched.
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.status).toBeUndefined();
  });

  it.each(['approved', 'declined', 'booked', 'cancelled', 'changes_requested'] as const)(
    'a %s quote is left byte-untouched — no status write attempted',
    async (status) => {
      const { client, updates } = makeSb(
        baseQuote({ status, viewed_at: '2026-07-01T12:00:00Z' }),
      );
      sbRef.current = client;

      const res = await POST(makeReq(), { params });

      expect(res.status).toBe(200);
      expect(updates).toHaveLength(1); // only the unconditional stamp
      expect(updates[0].payload.status).toBeUndefined();
    },
  );

  it('a null persisted status (pre-backfill legacy row) is left alone — no status write attempted', async () => {
    const { client, updates } = makeSb(baseQuote({ status: null }));
    sbRef.current = client;

    const res = await POST(makeReq(), { params });

    expect(res.status).toBe(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].payload.status).toBeUndefined();
  });

  it('a failed status-advance write is non-fatal — the view is still recorded successfully', async () => {
    const { client, updates } = makeSb(baseQuote({ status: 'sent' }), {
      statusUpdateError: { message: 'db unavailable' },
    });
    sbRef.current = client;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(makeReq(), { params });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(updates).toHaveLength(2); // the attempt still happened
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
