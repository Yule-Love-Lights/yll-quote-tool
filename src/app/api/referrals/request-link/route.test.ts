// Tests for POST /api/referrals/request-link (naldo/referral-self-serve).
//
// The load-bearing assertions are the uniform-response ones: the endpoint
// must return the identical body/status whether or not the typed email
// matches a GHL contact, and it must return WITHOUT waiting on any GHL
// call. The whole lookup/mint/send branch is scheduled with Next's after(),
// which this file mocks to a simple task-capturing queue so tests can
// choose whether, and when, to drain it.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { CrmContact } from '@/lib/integrations/types';
import type { NormalizedTouch } from '@/lib/dashboard/inbox/types';

const {
  searchContacts,
  getContact,
  sendEmail,
  upsertContactCustomField,
  findOrCreateCustomer,
  ensureReferralCode,
  hasReferralCode,
  ingestTouch,
  rateLimitedRef,
  ingestCapExhausted,
  checkRateLimit,
  emailCooldownSeen,
  afterTasks,
} = vi.hoisted(() => ({
  searchContacts: vi.fn(async (_query: string, _limit?: number) => [] as CrmContact[]),
  // naldo/referral-link-personalized: default REJECTS, mirroring
  // searchContacts' default empty-array "no match" above: a test must
  // opt in to a resolving contact rather than accidentally exercising the
  // mint chain.
  getContact: vi.fn(async (_id: string): Promise<CrmContact> => {
    throw new Error('not found');
  }),
  sendEmail: vi.fn(async (_input: unknown) => ({}) as unknown),
  upsertContactCustomField: vi.fn(async (_id: string, _field: string, _value: string | string[]) => undefined),
  findOrCreateCustomer: vi.fn(async (_identity: unknown) => ({ id: 'cust-1' }) as { id: string } | null),
  ensureReferralCode: vi.fn(async (_id: string) => 'CODE1234' as string | null),
  // Review fix 4: defaults false (no existing code = a first enrollment),
  // matching this same describe block's default findOrCreateCustomer/
  // ensureReferralCode fixtures, which model a brand-new customer.
  hasReferralCode: vi.fn(async (_id: string) => false),
  // Review fix 6: same fixture shape as submit/route.test.ts's own ingestTouch mock.
  ingestTouch: vi.fn(async (_touch: NormalizedTouch, _now: Date) => ({
    ok: true, skipped: false, itemId: 'inbox-item-1', contactId: null, autoResolved: false, reopened: false, ambiguous: false, skipReason: null,
  })),
  rateLimitedRef: { current: false },
  // Delta-verify fix A: the per-IP ceiling on the staff-record path, which is
  // a SEPARATE check from rateLimitedRef (the outer 429) and from the
  // per-email cooldown below. Exhausting it must silently skip the inbox
  // write and change nothing about the response.
  ingestCapExhausted: { current: false },
  // A real vi.fn() (not a plain arrow function), so a test can assert it
  // was never called at all: proof that the ingest cap is computed only
  // where it can ever be spent, not on a honeypot-tripped request that was
  // always going to skip recordRequestForStaff anyway.
  checkRateLimit: vi.fn((_req: unknown, _opts: unknown) =>
    ingestCapExhausted.current
      ? { ok: false, remaining: 0, resetMs: 3_600_000 }
      : { ok: true, remaining: 19, resetMs: 3_600_000 },
  ),
  // Review fix 3: mirrors the REAL checkRateLimitByKey's per-key "limit: 1"
  // semantics (first call for a key is ok, every later one is not) without
  // depending on wall-clock timing, decoupled from the outer per-IP mock
  // above (rateLimitedRef), which is a separate check entirely.
  emailCooldownSeen: new Set<string>(),
  afterTasks: [] as Array<() => Promise<void> | void>,
}));

// Real NextRequest/NextResponse are kept (spread from importOriginal);
// only after() is replaced, with a version that captures the scheduled task
// instead of running it, so a test controls when (or whether) it drains.
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return {
    ...actual,
    after: (task: () => Promise<void> | void) => {
      afterTasks.push(task);
    },
  };
});

vi.mock('@/lib/rateLimit', () => ({
  rateLimitResponse: (..._args: unknown[]) =>
    rateLimitedRef.current ? NextResponse.json({ error: 'Too many requests' }, { status: 429 }) : null,
  checkRateLimitByKey: (key: string, _opts: unknown) => {
    if (emailCooldownSeen.has(key)) return { ok: false, remaining: 0, resetMs: 3_600_000 };
    emailCooldownSeen.add(key);
    return { ok: true, remaining: 0, resetMs: 3_600_000 };
  },
  // Review fix 4b (this round): mirrors the real releaseRateLimitByKey's
  // undo-the-check semantics against this mock's own Set-based model, so a
  // test can prove a failed send frees the slot for a later retry.
  releaseRateLimitByKey: (key: string, _opts: unknown) => {
    emailCooldownSeen.delete(key);
  },
  // Delta-verify fix A: the per-IP ingest ceiling. checkRateLimit itself is
  // the hoisted vi.fn() above, so a test can assert on calls to it.
  checkRateLimit,
}));
vi.mock('@/lib/integrations/highlevel', () => ({ searchContacts, getContact, sendEmail, upsertContactCustomField }));
vi.mock('@/lib/customers', () => ({ findOrCreateCustomer }));
vi.mock('@/lib/referrals', () => ({ ensureReferralCode, hasReferralCode }));
vi.mock('@/lib/integrations/telegramNotify', () => ({ appBaseUrl: () => 'https://quote.example.com' }));
vi.mock('@/lib/dashboard/inbox/store', () => ({ ingestTouch }));

import { NextResponse } from 'next/server';
import { POST } from './route';

function req(body: unknown): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as NextRequest;
}

const MATCHING_CONTACT: CrmContact = {
  id: 'contact-1',
  source: 'highlevel',
  firstName: 'Jamie',
  lastName: 'Rivera',
  fullName: 'Jamie Rivera',
  email: 'jamie@example.com',
  phone: '6315550100',
};

// naldo/referral-link-personalized: the contact-id path's fixture. A
// separate id/name from MATCHING_CONTACT above so a test can tell the two
// paths' calls apart at a glance.
const RESOLVED_CONTACT: CrmContact = {
  id: 'ijusgE2q5QhlYjBZ6RG9',
  source: 'highlevel',
  firstName: 'Riley',
  lastName: 'Nguyen',
  fullName: 'Riley Nguyen',
  email: 'riley@example.com',
  phone: '6315550111',
};

async function drainAfterTasks() {
  const tasks = afterTasks.splice(0, afterTasks.length);
  for (const t of tasks) await t();
}

beforeEach(() => {
  vi.clearAllMocks();
  afterTasks.length = 0;
  rateLimitedRef.current = false;
  ingestCapExhausted.current = false;
  emailCooldownSeen.clear();
  // Review fix 2: the route 404s when this is unset, so every existing test
  // below (written before the flag existed) needs it on by default. The
  // flag's own on/off behavior is covered by the dedicated describe block
  // further down, which sets this explicitly per test.
  process.env.REFERRAL_SELF_SERVE_ENABLED = 'true';
  searchContacts.mockResolvedValue([]);
  getContact.mockRejectedValue(new Error('not found'));
  sendEmail.mockResolvedValue({});
  upsertContactCustomField.mockResolvedValue(undefined);
  findOrCreateCustomer.mockResolvedValue({ id: 'cust-1' });
  ensureReferralCode.mockResolvedValue('CODE1234');
  hasReferralCode.mockResolvedValue(false);
  delete process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_STATUS;
  delete process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_ENROLLMENT_DATE;
});

describe('REFERRAL_SELF_SERVE_ENABLED flag (review fix 2)', () => {
  it('404s and schedules nothing when the flag is unset', async () => {
    delete process.env.REFERRAL_SELF_SERVE_ENABLED;
    const res = await POST(req({ email: 'jamie@example.com' }));
    expect(res.status).toBe(404);
    expect(afterTasks).toHaveLength(0);
    expect(searchContacts).not.toHaveBeenCalled();
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
  });

  it('404s for anything other than the literal string "true" (strict comparison)', async () => {
    process.env.REFERRAL_SELF_SERVE_ENABLED = 'TRUE';
    const res = await POST(req({ email: 'jamie@example.com' }));
    expect(res.status).toBe(404);
    expect(afterTasks).toHaveLength(0);
  });

  it('proceeds normally when the flag is the literal string "true"', async () => {
    process.env.REFERRAL_SELF_SERVE_ENABLED = 'true';
    const res = await POST(req({ email: 'jamie@example.com' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(afterTasks).toHaveLength(1);
  });

  // naldo/referral-link-personalized bar item: "The flag off still 404s
  // both paths."
  it('404s the contact-id path too when the flag is unset, before any GHL call', async () => {
    delete process.env.REFERRAL_SELF_SERVE_ENABLED;
    getContact.mockResolvedValue(RESOLVED_CONTACT);
    const res = await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    expect(res.status).toBe(404);
    expect(getContact).not.toHaveBeenCalled();
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
  });
});

describe('POST /api/referrals/request-link', () => {
  it('429s when rate limited, before scheduling any lookup', async () => {
    rateLimitedRef.current = true;
    const res = await POST(req({ email: 'a@b.com' }));
    expect(res.status).toBe(429);
    expect(afterTasks).toHaveLength(0);
  });

  it('400s on invalid JSON', async () => {
    const bad = { headers: { get: () => null }, json: async () => { throw new Error('bad'); } } as unknown as NextRequest;
    const res = await POST(bad);
    expect(res.status).toBe(400);
  });

  it('400s on a missing or malformed email', async () => {
    for (const body of [{}, { email: '' }, { email: 'not-an-email' }, { email: 123 }]) {
      const res = await POST(req(body));
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(afterTasks).toHaveLength(0);
  });

  it('honeypot tripped: ok:true, but schedules no lookup at all', async () => {
    const res = await POST(req({ email: 'jamie@example.com', company: 'a bot filled this' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(afterTasks).toHaveLength(0);
    await drainAfterTasks();
    expect(searchContacts).not.toHaveBeenCalled();
  });

  it('returns 200 immediately without waiting on the GHL lookup', async () => {
    // searchContacts never resolves. If the route awaited it inline, this
    // test would hang and time out.
    searchContacts.mockImplementation(() => new Promise(() => {}));
    const res = await POST(req({ email: 'jamie@example.com' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The real work WAS scheduled, it just never blocked the response.
    expect(afterTasks).toHaveLength(1);
  });

  it('response body and status are byte-identical for a match and a no-match', async () => {
    searchContacts.mockResolvedValueOnce([MATCHING_CONTACT]);
    const matchRes = await POST(req({ email: 'jamie@example.com' }));
    const matchBody = await matchRes.json();

    searchContacts.mockResolvedValueOnce([]);
    const noMatchRes = await POST(req({ email: 'nobody@example.com' }));
    const noMatchBody = await noMatchRes.json();

    expect(matchRes.status).toBe(noMatchRes.status);
    expect(matchBody).toEqual(noMatchBody);
    expect(matchBody).toEqual({ ok: true });
  });

  // naldo/referral-link-personalized: the load-bearing cross-path isolation
  // check. mintAndSendReferralLink is now shared code, so this proves the
  // email path stays byte-identical (same status, same body, and never
  // touches getContact at all) even with a contact-id lookup primed to
  // succeed right alongside it.
  it('stays byte-identical even with a contact-id mock primed to succeed, and never calls getContact', async () => {
    getContact.mockResolvedValue(RESOLVED_CONTACT);

    searchContacts.mockResolvedValueOnce([MATCHING_CONTACT]);
    const matchRes = await POST(req({ email: 'jamie@example.com' }));
    const matchBody = await matchRes.json();
    await drainAfterTasks();

    searchContacts.mockResolvedValueOnce([]);
    const noMatchRes = await POST(req({ email: 'nobody@example.com' }));
    const noMatchBody = await noMatchRes.json();
    await drainAfterTasks();

    expect(matchRes.status).toBe(noMatchRes.status);
    expect(matchBody).toEqual(noMatchBody);
    expect(matchBody).toEqual({ ok: true });
    // Proven AFTER draining the deferred work too, not just on the
    // immediate response: the email path's mint-and-send chain genuinely
    // never reaches getContact, even though the two paths now share
    // mintAndSendReferralLink underneath.
    expect(getContact).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledTimes(1); // only the matched email above, the no-match sends nothing
  });

  it('no match: writes nothing once the scheduled task runs', async () => {
    searchContacts.mockResolvedValue([]);
    await POST(req({ email: 'nobody@example.com' }));
    await drainAfterTasks();
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
    expect(ensureReferralCode).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a fuzzy searchContacts hit that is not an EXACT email match mints and sends nothing', async () => {
    searchContacts.mockResolvedValue([
      { ...MATCHING_CONTACT, id: 'contact-2', email: 'jamie.rivera+other@example.com' },
    ]);
    await POST(req({ email: 'jamie@example.com' }));
    await drainAfterTasks();
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('exact match (case and whitespace insensitive): mints the code and emails the link', async () => {
    searchContacts.mockResolvedValue([MATCHING_CONTACT]);
    await POST(req({ email: '  Jamie@Example.com  ' }));
    await drainAfterTasks();

    expect(findOrCreateCustomer).toHaveBeenCalledWith(
      {
        hl_contact_id: 'contact-1',
        email: 'jamie@example.com',
        name: 'Jamie Rivera',
        phone: '6315550100',
      },
      // Review fix 5: this anonymous route must never refresh an existing
      // customer's stored identity fields.
      { skipIdentityRefresh: true },
    );
    expect(ensureReferralCode).toHaveBeenCalledWith('cust-1');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sendArgs = sendEmail.mock.calls[0]![0] as { contactId: string; subject: string; html: string };
    expect(sendArgs.contactId).toBe('contact-1');
    expect(sendArgs.html).toContain('https://quote.example.com/refer/CODE1234');
  });

  it('review fix 3: a second submission for the same normalized email within the cooldown window sends nothing, and the response stays byte-identical', async () => {
    searchContacts.mockResolvedValue([MATCHING_CONTACT]);

    const first = await POST(req({ email: 'jamie@example.com' }));
    const firstBody = await first.json();
    await drainAfterTasks();
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // Different case/whitespace, same normalized email: resolves to the
    // SAME GHL contact (MATCHING_CONTACT), so the cooldown (keyed on
    // match.id, review fix 4c this round) still catches it even though the
    // key is no longer derived from the email string itself.
    const second = await POST(req({ email: '  Jamie@Example.com  ' }));
    const secondBody = await second.json();
    await drainAfterTasks();

    expect(sendEmail).toHaveBeenCalledTimes(1); // still just once
    // Review fix 4a (this round): the cooldown gates the SEND only, not the
    // mint, so findOrCreateCustomer runs again on the second submission
    // (findOrCreateCustomer/ensureReferralCode are both idempotent
    // fetch-or-create, so this is a cheap repeat read, not wasted writes).
    expect(findOrCreateCustomer).toHaveBeenCalledTimes(2);
    expect(second.status).toBe(first.status);
    expect(secondBody).toEqual(firstBody);
  });

  it('review fix 3: the cooldown is keyed on the match, never on a no-match lookup', async () => {
    // A no-match query must never consume the cooldown slot a genuine later
    // match for the SAME email would need.
    searchContacts.mockResolvedValueOnce([]);
    await POST(req({ email: 'jamie@example.com' }));
    await drainAfterTasks();
    expect(sendEmail).not.toHaveBeenCalled();

    searchContacts.mockResolvedValueOnce([MATCHING_CONTACT]);
    await POST(req({ email: 'jamie@example.com' }));
    await drainAfterTasks();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('never sends when findOrCreateCustomer resolves null', async () => {
    searchContacts.mockResolvedValue([MATCHING_CONTACT]);
    findOrCreateCustomer.mockResolvedValue(null);
    await POST(req({ email: 'jamie@example.com' }));
    await drainAfterTasks();
    expect(ensureReferralCode).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('never sends when ensureReferralCode resolves null', async () => {
    searchContacts.mockResolvedValue([MATCHING_CONTACT]);
    ensureReferralCode.mockResolvedValue(null);
    await POST(req({ email: 'jamie@example.com' }));
    await drainAfterTasks();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('a thrown GHL error on the match branch never rejects the scheduled task', async () => {
    searchContacts.mockResolvedValue([MATCHING_CONTACT]);
    sendEmail.mockRejectedValue(new Error('HighLevel 500'));
    await POST(req({ email: 'jamie@example.com' }));
    await expect(drainAfterTasks()).resolves.toBeUndefined();
  });

  describe('Brand Ambassador stamps', () => {
    it('stamps both fields when both env vars are set', async () => {
      process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_STATUS = 'field-status-id';
      process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_ENROLLMENT_DATE = 'field-date-id';
      searchContacts.mockResolvedValue([MATCHING_CONTACT]);
      await POST(req({ email: 'jamie@example.com' }));
      await drainAfterTasks();

      expect(upsertContactCustomField).toHaveBeenCalledWith('contact-1', 'field-status-id', 'Active');
      expect(upsertContactCustomField).toHaveBeenCalledWith('contact-1', 'field-date-id', expect.any(String));
    });

    it('skips a stamp silently when its env var is unset', async () => {
      process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_STATUS = 'field-status-id';
      delete process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_ENROLLMENT_DATE;
      searchContacts.mockResolvedValue([MATCHING_CONTACT]);
      await POST(req({ email: 'jamie@example.com' }));
      await drainAfterTasks();

      expect(upsertContactCustomField).toHaveBeenCalledTimes(1);
      expect(upsertContactCustomField).toHaveBeenCalledWith('contact-1', 'field-status-id', 'Active');
    });

    it('one stamp failing never blocks the other, and never blocks the email send', async () => {
      process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_STATUS = 'field-status-id';
      process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_ENROLLMENT_DATE = 'field-date-id';
      upsertContactCustomField.mockRejectedValueOnce(new Error('status stamp failed'));
      searchContacts.mockResolvedValue([MATCHING_CONTACT]);
      await POST(req({ email: 'jamie@example.com' }));
      await drainAfterTasks();

      expect(sendEmail).toHaveBeenCalledTimes(1);
      expect(upsertContactCustomField).toHaveBeenCalledTimes(2);
    });

    it('review fix 4: stamps the enrollment date on a genuine first enrollment', async () => {
      process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_STATUS = 'field-status-id';
      process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_ENROLLMENT_DATE = 'field-date-id';
      hasReferralCode.mockResolvedValue(false); // no code yet, this mint is a first enrollment
      searchContacts.mockResolvedValue([MATCHING_CONTACT]);
      await POST(req({ email: 'jamie@example.com' }));
      await drainAfterTasks();

      expect(upsertContactCustomField).toHaveBeenCalledWith('contact-1', 'field-date-id', expect.any(String));
    });

    it('review fix 4: does NOT restamp the enrollment date on a resubmit, only Active', async () => {
      process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_STATUS = 'field-status-id';
      process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_ENROLLMENT_DATE = 'field-date-id';
      hasReferralCode.mockResolvedValue(true); // already has a code, this is a resubmit, not a first enrollment
      searchContacts.mockResolvedValue([MATCHING_CONTACT]);
      await POST(req({ email: 'jamie@example.com' }));
      await drainAfterTasks();

      expect(upsertContactCustomField).toHaveBeenCalledWith('contact-1', 'field-status-id', 'Active');
      expect(upsertContactCustomField).not.toHaveBeenCalledWith('contact-1', 'field-date-id', expect.any(String));
      expect(upsertContactCustomField).toHaveBeenCalledTimes(1); // status only
    });
  });

  describe('staff inbox record (review fix 6)', () => {
    it('records a match as an automated touch, never a lead', async () => {
      searchContacts.mockResolvedValue([MATCHING_CONTACT]);
      await POST(req({ email: 'jamie@example.com' }));
      await drainAfterTasks();

      expect(ingestTouch).toHaveBeenCalledTimes(1);
      const [touch] = ingestTouch.mock.calls[0]!;
      expect(touch.source).toBe('quotetool');
      expect(touch.leadKind).toBe('automated');
      expect(touch.identity.emails).toEqual(['jamie@example.com']);
    });

    it('records a no-match too (a no-match is a normal outcome, not a failure)', async () => {
      searchContacts.mockResolvedValue([]); // no match
      await POST(req({ email: 'nobody@example.com' }));
      await drainAfterTasks();

      expect(ingestTouch).toHaveBeenCalledTimes(1);
      const [touch] = ingestTouch.mock.calls[0]!;
      expect(touch.leadKind).toBe('automated');
    });

    it('never records anything when the honeypot is tripped, and never even spends an ingest-cap slot', async () => {
      await POST(req({ email: 'jamie@example.com', company: 'a bot filled this' }));
      await drainAfterTasks();
      expect(ingestTouch).not.toHaveBeenCalled();
      // Delta-verify fix A follow-up: the ingest-cap check must not run for
      // a tripped request either, so bot traffic hitting the honeypot can
      // never burn real users' shared-IP budget on a path that was always
      // going to skip recordRequestForStaff anyway.
      expect(checkRateLimit).not.toHaveBeenCalled();
    });

    // Named for what it actually asserts. ingestTouch is mocked here, so this
    // proves only that both submissions hand it the SAME externalId string.
    // Whether one row results rather than two is store.ts's upsert
    // (onConflict: 'source,external_id'), which this test never exercises.
    it('passes the same normalized-email externalId for a resubmission', async () => {
      searchContacts.mockResolvedValue([MATCHING_CONTACT]);
      await POST(req({ email: 'jamie@example.com' }));
      await drainAfterTasks();
      await POST(req({ email: '  Jamie@Example.com  ' }));
      await drainAfterTasks();

      const ids = ingestTouch.mock.calls.map((c) => c[0].externalId);
      expect(ids).toHaveLength(2);
      expect(ids[0]).toBe(ids[1]);
    });

    // Delta-verify fix A. The staff record is written for every request,
    // matched or not, on purpose: a write that happened only on a match would
    // be a match oracle for anyone with dashboard access. The cost is that a
    // no-match email INSERTs a dashboard_contacts row, so distinct garbage
    // emails could mint rows indefinitely. These two assert the per-IP
    // ceiling stops that WITHOUT the response changing, because a response
    // that changed would trade one leak for another.
    it('skips the staff record once the per-IP ingest cap is exhausted', async () => {
      searchContacts.mockResolvedValue([MATCHING_CONTACT]);
      ingestCapExhausted.current = true;

      await POST(req({ email: 'jamie@example.com' }));
      await drainAfterTasks();

      expect(ingestTouch).not.toHaveBeenCalled();
      // The match branch is a separate concern and must still run: the cap is
      // about row volume, not about withholding someone's referral link.
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });

    it('returns the identical status and body whether or not the ingest cap is exhausted', async () => {
      searchContacts.mockResolvedValue([MATCHING_CONTACT]);

      const under = await POST(req({ email: 'under@example.com' }));
      ingestCapExhausted.current = true;
      const over = await POST(req({ email: 'over@example.com' }));

      expect(over.status).toBe(under.status);
      expect(await over.json()).toEqual(await under.json());
    });

    it('a rejected ingestTouch never blocks the response or the match/send branch', async () => {
      ingestTouch.mockRejectedValueOnce(new Error('inbox table missing'));
      searchContacts.mockResolvedValue([MATCHING_CONTACT]);
      const res = await POST(req({ email: 'jamie@example.com' }));
      expect(res.status).toBe(200);
      await expect(drainAfterTasks()).resolves.toBeUndefined();
      expect(sendEmail).toHaveBeenCalledTimes(1);
    });
  });
});

// naldo/referral-link-personalized: the contact-id path. Only the lookup
// and the code mint are awaited inline (the response depends on them), so
// assertions about the RESPONSE (status, referralUrl) read straight off
// the POST call with no draining needed. Review fix 2 (staff record) and
// review fix 7 (send + Brand Ambassador stamps), both this round, defer
// the rest with after(): a test that asserts on sendEmail/
// upsertContactCustomField/ingestTouch needs drainAfterTasks() first.
describe('POST /api/referrals/request-link (contact-id path)', () => {
  it('review fix 7: a mid-chain kill after the response is built cannot leave the mint applied with no response delivered, because the mint IS the response', async () => {
    // Regression guard for the maxDuration risk fix 7 addresses: proves the
    // referralUrl in the response was produced by the SAME inline mint
    // that a caller could observe, not by a deferred step that might never
    // run. If this ever regressed to awaiting sendEmail inline again, this
    // test would still pass, so it is deliberately paired with the
    // "queued via after()" test below, which is the one that would catch
    // that regression.
    getContact.mockResolvedValue(RESOLVED_CONTACT);
    ensureReferralCode.mockResolvedValue('DEADLINE1');
    const res = await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    expect((await res.json()).referralUrl).toBe('https://quote.example.com/refer/DEADLINE1');
  });


  it('a contact id that resolves mints the code, sends the email, and returns the link in the body', async () => {
    getContact.mockResolvedValue(RESOLVED_CONTACT);
    const res = await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));

    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean; referralUrl?: string };
    expect(json.ok).toBe(true);
    expect(json.referralUrl).toBe('https://quote.example.com/refer/CODE1234');

    expect(getContact).toHaveBeenCalledWith('ijusgE2q5QhlYjBZ6RG9');
    expect(findOrCreateCustomer).toHaveBeenCalledWith(
      {
        hl_contact_id: 'ijusgE2q5QhlYjBZ6RG9',
        email: 'riley@example.com',
        name: 'Riley Nguyen',
        phone: '6315550111',
      },
      { skipIdentityRefresh: true },
    );
    expect(ensureReferralCode).toHaveBeenCalledWith('cust-1');

    // Review fix 7 (this round): the send is now deferred with after(), so
    // it hasn't run yet at this point, only after draining.
    expect(sendEmail).not.toHaveBeenCalled();
    await drainAfterTasks();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sendArgs = sendEmail.mock.calls[0]![0] as { contactId: string; html: string };
    expect(sendArgs.contactId).toBe('ijusgE2q5QhlYjBZ6RG9');
    expect(sendArgs.html).toContain('https://quote.example.com/refer/CODE1234');
  });

  it('the lookup and mint resolve inline: the response already carries the link, with send + stamps still queued via after()', async () => {
    getContact.mockResolvedValue(RESOLVED_CONTACT);
    const res = await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    expect((await res.json()).referralUrl).toBeTruthy();
    expect(sendEmail).not.toHaveBeenCalled();
    // Review fix 2 + review fix 7: two deferred tasks by the time the
    // response is built, the staff-record write and the send+stamp tail.
    expect(afterTasks).toHaveLength(2);
    await drainAfterTasks();
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('a contact id that does not resolve (getContact throws) returns the generic response with no link, and writes nothing', async () => {
    // A validly-formatted id (passes CONTACT_ID_RE, review fix 9) that GHL
    // simply doesn't recognize, distinct from RESOLVED_CONTACT's own id, so
    // this exercises the getContact-throws branch specifically rather than
    // the format guard covered in its own describe block below.
    getContact.mockRejectedValue(new Error('HighLevel GET /contacts/GveMd2lybT1rfkBdReTD -> 404'));
    const res = await POST(req({ contactId: 'GveMd2lybT1rfkBdReTD' }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(getContact).toHaveBeenCalledWith('GveMd2lybT1rfkBdReTD');
    expect(findOrCreateCustomer).not.toHaveBeenCalled();
    expect(ensureReferralCode).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('never sends when findOrCreateCustomer resolves null', async () => {
    getContact.mockResolvedValue(RESOLVED_CONTACT);
    findOrCreateCustomer.mockResolvedValue(null);
    const res = await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    expect(await res.json()).toEqual({ ok: true });
    expect(ensureReferralCode).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('never sends when ensureReferralCode resolves null', async () => {
    getContact.mockResolvedValue(RESOLVED_CONTACT);
    ensureReferralCode.mockResolvedValue(null);
    const res = await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    expect(await res.json()).toEqual({ ok: true });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('clicking twice does not send two emails, but the link still comes back both times (review fix 4a, this round)', async () => {
    getContact.mockResolvedValue(RESOLVED_CONTACT);

    const first = await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    const firstJson = (await first.json()) as { referralUrl?: string };
    await drainAfterTasks();
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(firstJson.referralUrl).toBeTruthy();

    const second = await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    const secondJson = (await second.json()) as { referralUrl?: string };
    await drainAfterTasks();
    expect(sendEmail).toHaveBeenCalledTimes(1); // still just once, the cooldown gated the SEND
    // Review fix 4a: the cooldown no longer blocks the mint, so the second
    // click still gets the (already-minted, safe-to-redisplay) link back,
    // instead of falling through to the generic no-link screen.
    expect(secondJson.referralUrl).toBe(firstJson.referralUrl);
    // And the mint genuinely ran again (an idempotent fetch-or-create, not
    // wasted writes), it wasn't short-circuited by the cooldown.
    expect(findOrCreateCustomer).toHaveBeenCalledTimes(2);
  });

  it('review fix 4b: a failed send releases the cooldown slot, so a later click in the same hour can still succeed', async () => {
    getContact.mockResolvedValue(RESOLVED_CONTACT);
    sendEmail.mockRejectedValueOnce(new Error('HighLevel 500'));

    await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    // The failed send is caught inside findAndSendForContactId's own
    // after() wrapper, so draining must not reject.
    await expect(drainAfterTasks()).resolves.toBeUndefined();
    expect(sendEmail).toHaveBeenCalledTimes(1);

    await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    await drainAfterTasks();
    // Released, not spent: the retry could send.
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('review fix 4b: a failed send skips the Brand Ambassador stamps too, same coupling as before the fix 7 split', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_STATUS = 'field-status-id';
    getContact.mockResolvedValue(RESOLVED_CONTACT);
    sendEmail.mockRejectedValueOnce(new Error('HighLevel 500'));

    await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    await drainAfterTasks();
    expect(upsertContactCustomField).not.toHaveBeenCalled();
  });

  it('review fix 4c: the email and contact-id paths share one cooldown when they resolve to the same GHL contact', async () => {
    // Both paths resolve to a contact sharing the SAME id, the way the
    // same real person could show up through either channel.
    searchContacts.mockResolvedValue([MATCHING_CONTACT]);
    getContact.mockResolvedValue({ ...RESOLVED_CONTACT, id: MATCHING_CONTACT.id });

    await POST(req({ email: 'jamie@example.com' }));
    await drainAfterTasks();
    expect(sendEmail).toHaveBeenCalledTimes(1);

    const second = await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    const secondJson = (await second.json()) as { referralUrl?: string };
    await drainAfterTasks();
    // Still just once: the SAME hourly budget covered both channels.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // The contact-id path still gets its link back either way (fix 4a).
    expect(secondJson.referralUrl).toBeTruthy();
  });

  it('honeypot tripped: generic response, no lookup at all', async () => {
    const res = await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9', company: 'a bot filled this' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(getContact).not.toHaveBeenCalled();
  });

  it('applies the same Brand Ambassador stamps as the email path', async () => {
    process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_STATUS = 'field-status-id';
    process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_ENROLLMENT_DATE = 'field-date-id';
    getContact.mockResolvedValue(RESOLVED_CONTACT);
    await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    // Review fix 7: the stamps are deferred along with the send now.
    await drainAfterTasks();
    expect(upsertContactCustomField).toHaveBeenCalledWith('ijusgE2q5QhlYjBZ6RG9', 'field-status-id', 'Active');
    expect(upsertContactCustomField).toHaveBeenCalledWith('ijusgE2q5QhlYjBZ6RG9', 'field-date-id', expect.any(String));
  });

  it('a contact with no email on file still mints and sends, keyed on the id alone', async () => {
    getContact.mockResolvedValue({ ...RESOLVED_CONTACT, email: undefined });
    const res = await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    expect((await res.json()).referralUrl).toBeTruthy();
    expect(findOrCreateCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ email: null }),
      { skipIdentityRefresh: true },
    );
  });

  describe('staff inbox record (review fix 2, this round)', () => {
    it('records an automated touch, deferred, once a contact id resolves', async () => {
      getContact.mockResolvedValue(RESOLVED_CONTACT);
      const res = await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
      // Not written yet: it's scheduled, not run, before the response.
      expect(ingestTouch).not.toHaveBeenCalled();
      expect((await res.json()).referralUrl).toBeTruthy();

      await drainAfterTasks();
      expect(ingestTouch).toHaveBeenCalledTimes(1);
      const [touch] = ingestTouch.mock.calls[0]!;
      expect(touch.source).toBe('quotetool');
      expect(touch.leadKind).toBe('automated');
      expect(touch.identity.ghlContactId).toBe('ijusgE2q5QhlYjBZ6RG9');
      expect(touch.identity.emails).toEqual(['riley@example.com']);
    });

    it('records even when the mint/send chain later fails, so a cooldown or a dead customer lookup still leaves a trace', async () => {
      getContact.mockResolvedValue(RESOLVED_CONTACT);
      findOrCreateCustomer.mockResolvedValue(null);
      await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
      await drainAfterTasks();
      expect(ingestTouch).toHaveBeenCalledTimes(1);
    });

    it('records nothing for a contact id that never resolves (no reliable signal a real person did anything)', async () => {
      getContact.mockRejectedValue(new Error('HighLevel GET /contacts/GveMd2lybT1rfkBdReTD -> 404'));
      await POST(req({ contactId: 'GveMd2lybT1rfkBdReTD' }));
      await drainAfterTasks();
      expect(ingestTouch).not.toHaveBeenCalled();
    });

    it('records nothing for a format-rejected id (review fix 9) or a honeypot trip', async () => {
      await POST(req({ contactId: 'not-a-real-id!' }));
      await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9', company: 'a bot filled this' }));
      await drainAfterTasks();
      expect(ingestTouch).not.toHaveBeenCalled();
    });

    it('a rejected ingestTouch never rejects the scheduled task or affects the already-sent response', async () => {
      getContact.mockResolvedValue(RESOLVED_CONTACT);
      ingestTouch.mockRejectedValueOnce(new Error('inbox table missing'));
      const res = await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
      expect((await res.json()).referralUrl).toBeTruthy();
      await expect(drainAfterTasks()).resolves.toBeUndefined();
    });

    it('never inflates totalLeads or fires an escalation: leadKind is automated, matching store.ts own exclusion filters', async () => {
      getContact.mockResolvedValue(RESOLVED_CONTACT);
      await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
      await drainAfterTasks();
      const [touch] = ingestTouch.mock.calls[0]!;
      // store.ts: totalLeads subtracts lead_kind='automated' rows, and
      // listEscalatableItems' own `.or('lead_kind.is.null,lead_kind.neq.automated')`
      // filter excludes them outright (verified by reading store.ts directly,
      // this round). A wrong leadKind here would silently bury real leads or
      // fire false escalations under campaign-blast volume.
      expect(touch.leadKind).toBe('automated');
    });
  });

  it('the outer per-IP rate limit still applies to the contact-id path', async () => {
    rateLimitedRef.current = true;
    const res = await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    expect(res.status).toBe(429);
    expect(getContact).not.toHaveBeenCalled();
  });
});

// naldo/referral-link-personalized bar items: "A body with both email and
// contactId is rejected" / "A body with neither is rejected."
describe('POST /api/referrals/request-link (body validation: email vs contactId)', () => {
  it('rejects a body carrying both email and contactId, before either path runs', async () => {
    const res = await POST(req({ email: 'jamie@example.com', contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    expect(res.status).toBe(400);
    expect(getContact).not.toHaveBeenCalled();
    expect(searchContacts).not.toHaveBeenCalled();
  });

  it('rejects an empty body (neither field present)', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(getContact).not.toHaveBeenCalled();
  });

  it('rejects a body with an unrelated field but neither email nor contactId', async () => {
    const res = await POST(req({ company: '' }));
    expect(res.status).toBe(400);
    expect(getContact).not.toHaveBeenCalled();
  });

  it('an empty-string contactId is treated as not provided, falling through to the email validation', async () => {
    const res = await POST(req({ contactId: '' }));
    expect(res.status).toBe(400);
    expect(getContact).not.toHaveBeenCalled();
  });
});

// Review fix 9: the CONTACT_ID_RE format guard. A rejected id must look
// identical to a failed lookup from the outside (generic 200, no link), and
// must never reach GHL at all.
describe('POST /api/referrals/request-link (contact-id format guard, review fix 9)', () => {
  it('rejects an id with non-alphanumeric characters before calling getContact', async () => {
    const res = await POST(req({ contactId: 'not-a-real-ghl-id!' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(getContact).not.toHaveBeenCalled();
  });

  it('rejects an id shorter than the tolerance window', async () => {
    const res = await POST(req({ contactId: 'tooShort123' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(getContact).not.toHaveBeenCalled();
  });

  it('rejects an id longer than the tolerance window', async () => {
    const res = await POST(req({ contactId: 'a'.repeat(40) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(getContact).not.toHaveBeenCalled();
  });

  it('accepts the measured real-world length (20 chars, mixed-case alphanumeric)', async () => {
    getContact.mockResolvedValue(RESOLVED_CONTACT);
    const res = await POST(req({ contactId: 'ijusgE2q5QhlYjBZ6RG9' }));
    expect(await res.json()).toMatchObject({ ok: true, referralUrl: expect.any(String) });
    expect(getContact).toHaveBeenCalledWith('ijusgE2q5QhlYjBZ6RG9');
  });
});
