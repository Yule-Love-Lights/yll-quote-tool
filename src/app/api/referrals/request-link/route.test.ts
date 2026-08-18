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

const {
  searchContacts,
  sendEmail,
  upsertContactCustomField,
  findOrCreateCustomer,
  ensureReferralCode,
  rateLimitedRef,
  afterTasks,
} = vi.hoisted(() => ({
  searchContacts: vi.fn(async (_query: string, _limit?: number) => [] as CrmContact[]),
  sendEmail: vi.fn(async (_input: unknown) => ({}) as unknown),
  upsertContactCustomField: vi.fn(async (_id: string, _field: string, _value: string | string[]) => undefined),
  findOrCreateCustomer: vi.fn(async (_identity: unknown) => ({ id: 'cust-1' }) as { id: string } | null),
  ensureReferralCode: vi.fn(async (_id: string) => 'CODE1234' as string | null),
  rateLimitedRef: { current: false },
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
}));
vi.mock('@/lib/integrations/highlevel', () => ({ searchContacts, sendEmail, upsertContactCustomField }));
vi.mock('@/lib/customers', () => ({ findOrCreateCustomer }));
vi.mock('@/lib/referrals', () => ({ ensureReferralCode }));
vi.mock('@/lib/integrations/telegramNotify', () => ({ appBaseUrl: () => 'https://quote.example.com' }));

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

async function drainAfterTasks() {
  const tasks = afterTasks.splice(0, afterTasks.length);
  for (const t of tasks) await t();
}

beforeEach(() => {
  vi.clearAllMocks();
  afterTasks.length = 0;
  rateLimitedRef.current = false;
  // Review fix 2: the route 404s when this is unset, so every existing test
  // below (written before the flag existed) needs it on by default. The
  // flag's own on/off behavior is covered by the dedicated describe block
  // further down, which sets this explicitly per test.
  process.env.REFERRAL_SELF_SERVE_ENABLED = 'true';
  searchContacts.mockResolvedValue([]);
  sendEmail.mockResolvedValue({});
  upsertContactCustomField.mockResolvedValue(undefined);
  findOrCreateCustomer.mockResolvedValue({ id: 'cust-1' });
  ensureReferralCode.mockResolvedValue('CODE1234');
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

    expect(findOrCreateCustomer).toHaveBeenCalledWith({
      hl_contact_id: 'contact-1',
      email: 'jamie@example.com',
      name: 'Jamie Rivera',
      phone: '6315550100',
    });
    expect(ensureReferralCode).toHaveBeenCalledWith('cust-1');
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sendArgs = sendEmail.mock.calls[0]![0] as { contactId: string; subject: string; html: string };
    expect(sendArgs.contactId).toBe('contact-1');
    expect(sendArgs.html).toContain('https://quote.example.com/refer/CODE1234');
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
  });
});
