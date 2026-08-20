// Tests for POST /api/quotes/[id]/reopen-request (ledger row 236).
// The customer asks staff to reopen a dead quote. The route:
//   - validates the UUID (400);
//   - skips a staff preview BEFORE any DB work or cooldown claim (fix round,
//     four-lens MED — mirrors view/route.ts + interested/route.ts);
//   - only allows it when canRevive(current status) — declined/abandoned
//     only, everything else (sent/viewed/approved/booked/cancelled/
//     changes_requested) → 409;
//   - fires a best-effort internal staff email (no status write, no GHL move),
//     carrying the quote NUMBER in the subject/body (fix round, four-lens LOW
//     — matches amendmentDeclinedInternalEmail*/internalDepositDeclinedEmail*'s
//     format);
//   - cools down repeat clicks on the SAME quote (in-memory, keyed by id) so
//     a mashed button doesn't spam staff with duplicate emails.
//
// Supabase + HighLevel mocked.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { sbRef, hl, emailCooldownSeen, staff } = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  hl: {
    configured: { value: true },
    sendEmail: vi.fn(async (_args: { subject: string; html: string; contactId: string }) => ({})),
  },
  // Mirrors referral request-link's route.test.ts fake — a Set-based model of
  // checkRateLimitByKey's real per-key "limit: 1" semantics (first call for a
  // key is ok, every later one is not) without depending on wall-clock timing.
  emailCooldownSeen: new Set<string>(),
  // Mirrors interested/route.test.ts's staff-preview fake exactly.
  staff: { current: false },
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

// Staff-preview detection is unit-tested in lib/auth/staffDevice.test.ts; here
// we just drive its outcome to confirm the route honours a staff skip.
vi.mock('@/lib/auth/staffDevice', () => ({ isStaffPreview: async () => staff.current }));

vi.mock('@/lib/rateLimit', () => ({
  rateLimitResponse: () => null,
  checkRateLimitByKey: (key: string, _opts: unknown) => {
    if (emailCooldownSeen.has(key)) return { ok: false, remaining: 0, resetMs: 3_600_000 };
    emailCooldownSeen.add(key);
    return { ok: true, remaining: 0, resetMs: 3_600_000 };
  },
  releaseRateLimitByKey: (key: string, _opts: unknown) => {
    emailCooldownSeen.delete(key);
  },
}));

vi.mock('@/lib/integrations/highlevel', () => ({
  isHighLevelConfigured: () => hl.configured.value,
  sendEmail: hl.sendEmail,
  HighLevelError: class HighLevelError extends Error {},
}));

import { POST } from './route';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ID2 = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';

function baseQuote(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    quote_number: 1234,
    customer_name: 'Jordan Smith',
    customer_address: '1 Main St',
    customer_phone: '+15555550123',
    customer_email: 'jordan@example.com',
    highlevel_contact_id: null,
    quote_sent_at: '2026-06-25T00:00:00Z',
    customer_approved_at: null,
    deposit_paid_at: null,
    viewed_at: '2026-06-25T01:00:00Z',
    status: 'declined',
    ...overrides,
  };
}

function makeSb(quote: Record<string, unknown> | null) {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: () => builder,
    eq: () => builder,
    single: async () => ({ data: quote, error: quote ? null : { message: 'no row' } }),
  });
  return { client: builder };
}

function makeReq(): NextRequest {
  return {
    json: async () => ({}),
    headers: { get: () => null },
    nextUrl: { origin: 'https://quote.example.com' },
  } as unknown as NextRequest;
}

function params(id = ID) {
  return Promise.resolve({ id });
}

beforeEach(() => {
  vi.clearAllMocks();
  hl.configured.value = false;
  emailCooldownSeen.clear();
  staff.current = false;
  delete process.env.HIGHLEVEL_INTERNAL_CONTACT_ID;
});

describe('POST /api/quotes/[id]/reopen-request', () => {
  it('accepts a reopen request on a declined quote', async () => {
    const { client } = makeSb(baseQuote({ status: 'declined' }));
    sbRef.current = client;

    const res = await POST(makeReq(), { params: params() });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it('accepts a reopen request on an abandoned quote', async () => {
    const { client } = makeSb(baseQuote({ status: 'abandoned' }));
    sbRef.current = client;

    const res = await POST(makeReq(), { params: params(ID2) });
    expect(res.status).toBe(200);
  });

  it('rejects a bad UUID → 400', async () => {
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(), { params: Promise.resolve({ id: 'not-a-uuid' }) });
    expect(res.status).toBe(400);
  });

  // Fix round (four-lens, MED) — row 236's browse mode makes this button the
  // ONLY CTA on a staff preview of a terminal quote's portal; a staff click
  // must not fire a real internal email indistinguishable from a genuine
  // customer ask. Mirrors interested/route.test.ts's staff-skip test exactly.
  it('skips a staff preview (row 236 fix) — before any DB work', async () => {
    staff.current = true;
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    // sbRef.current is left null (no client at all) — the route would throw
    // reaching for `sb.from(...)` if it touched the DB, proving the skip
    // fires before any DB work, same as its siblings.
    sbRef.current = null;

    const res = await POST(makeReq(), { params: params() });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.skipped).toBe('staff');
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('a staff-skipped click does NOT burn the customer cooldown slot', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';

    // First: a staff preview click — no DB, no email, no cooldown claim.
    staff.current = true;
    sbRef.current = null;
    const staffRes = await POST(makeReq(), { params: params() });
    expect((await staffRes.json()).skipped).toBe('staff');
    expect(hl.sendEmail).not.toHaveBeenCalled();

    // Then: a real customer click on the SAME quote id — must send normally,
    // not read as "already cooled down" from the staff click above.
    staff.current = false;
    const { client } = makeSb(baseQuote());
    sbRef.current = client;
    const customerRes = await POST(makeReq(), { params: params() });
    const customerJson = await customerRes.json();
    expect(customerRes.status).toBe(200);
    expect(customerJson.skipped).toBeUndefined();
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('404s a missing quote', async () => {
    const { client } = makeSb(null);
    sbRef.current = client;

    const res = await POST(makeReq(), { params: params() });
    expect(res.status).toBe(404);
  });

  it.each(['sent', 'viewed', 'approved', 'booked', 'cancelled', 'changes_requested'])(
    'refuses a reopen request on a %s quote → 409',
    async (status) => {
      const overrides: Record<string, unknown> = { status };
      if (status === 'approved' || status === 'booked') overrides.customer_approved_at = '2026-06-26T00:00:00Z';
      if (status === 'booked') overrides.deposit_paid_at = '2026-06-27T00:00:00Z';
      const { client } = makeSb(baseQuote(overrides));
      sbRef.current = client;

      const res = await POST(makeReq(), { params: params() });
      const json = await res.json();
      expect(res.status).toBe(409);
      expect(json.code).toBe('invalid-status');
    },
  );

  it('fires a best-effort staff email when HighLevel is configured', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(), { params: params() });
    expect(res.status).toBe(200);
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);
  });

  // Fix round (four-lens, LOW) — the quote number is what a triaging staffer
  // scans an inbox for, same reasoning as the money-alert siblings
  // (amendmentDeclinedInternalEmail*/internalDepositDeclinedEmail*).
  it('includes the quote number in the subject and body when present', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    const { client } = makeSb(baseQuote({ quote_number: 4321 }));
    sbRef.current = client;

    const res = await POST(makeReq(), { params: params() });
    expect(res.status).toBe(200);
    const call = hl.sendEmail.mock.calls[0]![0] as { subject: string; html: string };
    expect(call.subject).toContain('quote #4321');
    expect(call.html).toContain('(quote #4321)');
  });

  it('omits the quote-number label entirely when quote_number is null', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    const { client } = makeSb(baseQuote({ quote_number: null }));
    sbRef.current = client;

    const res = await POST(makeReq(), { params: params() });
    expect(res.status).toBe(200);
    const call = hl.sendEmail.mock.calls[0]![0] as { subject: string; html: string };
    expect(call.subject).not.toContain('quote #');
    expect(call.html).not.toContain('(quote #');
  });

  it('still 200s when the staff email throws (best-effort)', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    hl.sendEmail.mockRejectedValueOnce(new Error('GHL down'));
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(), { params: params() });
    expect(res.status).toBe(200);
  });

  it('still 200s (skips silently) when HighLevel is unconfigured', async () => {
    hl.configured.value = false;
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const res = await POST(makeReq(), { params: params() });
    expect(res.status).toBe(200);
    expect(hl.sendEmail).not.toHaveBeenCalled();
  });

  it('cools down a second request for the SAME quote within the window (no duplicate email)', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const first = await POST(makeReq(), { params: params() });
    expect(first.status).toBe(200);
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);

    const second = await POST(makeReq(), { params: params() });
    const secondJson = await second.json();
    expect(second.status).toBe(200);
    expect(secondJson.skipped).toBe('cooldown');
    // Still only the ONE send from the first request.
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);
  });

  it('releases the cooldown slot on a failed send, so an immediate retry can still send', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    hl.sendEmail.mockRejectedValueOnce(new Error('GHL down'));
    const { client } = makeSb(baseQuote());
    sbRef.current = client;

    const first = await POST(makeReq(), { params: params() });
    expect(first.status).toBe(200);
    expect(hl.sendEmail).toHaveBeenCalledTimes(1);

    const second = await POST(makeReq(), { params: params() });
    const secondJson = await second.json();
    expect(second.status).toBe(200);
    expect(secondJson.skipped).toBeUndefined();
    expect(hl.sendEmail).toHaveBeenCalledTimes(2);
  });

  it('a different quote id is NOT cooled down by another quote requesting reopen', async () => {
    hl.configured.value = true;
    process.env.HIGHLEVEL_INTERNAL_CONTACT_ID = 'internal-1';
    const { client: client1 } = makeSb(baseQuote({ id: ID }));
    sbRef.current = client1;
    await POST(makeReq(), { params: params(ID) });

    const { client: client2 } = makeSb(baseQuote({ id: ID2 }));
    sbRef.current = client2;
    const res = await POST(makeReq(), { params: params(ID2) });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.skipped).toBeUndefined();
    expect(hl.sendEmail).toHaveBeenCalledTimes(2);
  });
});
