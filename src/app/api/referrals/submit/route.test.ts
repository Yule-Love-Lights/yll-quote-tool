// Tests for POST /api/referrals/submit (ledger #41 — referral landing page).
// Public route: rate-limited, re-validates the code server-side, and creates
// three things best-effort (GHL contact, inbox item, pending referral row) —
// only a malformed request or an unknown code should ever fail the response.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextResponse, type NextRequest } from 'next/server';
import type { NormalizedTouch } from '@/lib/dashboard/inbox/types';

const { getReferralByCode, createPendingReferral, createContact, hlConfigured, ingestTouch, rateLimitedRef } = vi.hoisted(() => ({
  getReferralByCode: vi.fn(async () => null as { customerId: string; name: string | null; photoOptout: boolean } | null),
  createPendingReferral: vi.fn(async () => ({ id: 'referral-1' }) as { id: string } | null),
  createContact: vi.fn(async () => ({ id: 'contact-1' })),
  hlConfigured: { value: true },
  ingestTouch: vi.fn(async (_touch: NormalizedTouch, _now: Date) => ({
    ok: true, skipped: false, itemId: 'item-1', contactId: null, autoResolved: false, reopened: false, ambiguous: false,
  })),
  rateLimitedRef: { current: false },
}));

vi.mock('@/lib/rateLimit', () => ({
  rateLimitResponse: () =>
    rateLimitedRef.current
      ? NextResponse.json({ error: 'Too many requests' }, { status: 429 })
      : null,
}));
vi.mock('@/lib/referrals', () => ({ getReferralByCode, createPendingReferral }));
vi.mock('@/lib/integrations/highlevel', () => ({
  createContact,
  isHighLevelConfigured: () => hlConfigured.value,
}));
vi.mock('@/lib/dashboard/inbox/store', () => ({ ingestTouch }));

import { POST } from './route';

function makeReq(body: unknown): NextRequest {
  return {
    json: async () => body,
    headers: { get: () => null },
  } as unknown as NextRequest;
}

const VALID_BODY = {
  code: 'ABCD1234',
  name: 'Sam Rivera',
  phone: '(516) 555-0123',
  address: '123 Main St, Smithtown, NY',
  email: 'sam@example.com',
};

beforeEach(() => {
  vi.clearAllMocks();
  rateLimitedRef.current = false;
  hlConfigured.value = true;
  getReferralByCode.mockResolvedValue({ customerId: 'cust-1', name: 'Jordan Smith', photoOptout: false });
  createPendingReferral.mockResolvedValue({ id: 'referral-1' });
  createContact.mockResolvedValue({ id: 'contact-1' });
});

describe('POST /api/referrals/submit', () => {
  it('429s when rate limited, before ever checking the code', async () => {
    rateLimitedRef.current = true;
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(429);
    expect(getReferralByCode).not.toHaveBeenCalled();
  });

  it('400s on invalid JSON', async () => {
    const req = { json: async () => { throw new Error('bad json'); }, headers: { get: () => null } } as unknown as NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('400s when the referral code is missing', async () => {
    const res = await POST(makeReq({ ...VALID_BODY, code: undefined }));
    expect(res.status).toBe(400);
    expect(getReferralByCode).not.toHaveBeenCalled();
  });

  it('404s on an unknown/invalid referral code — server-side re-validation', async () => {
    getReferralByCode.mockResolvedValueOnce(null);
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(404);
    expect(createPendingReferral).not.toHaveBeenCalled();
  });

  it('400s when name, phone, or address is missing', async () => {
    const res = await POST(makeReq({ ...VALID_BODY, phone: '   ' }));
    expect(res.status).toBe(400);
    expect(createPendingReferral).not.toHaveBeenCalled();
  });

  it('creates the GHL contact tagged referral, the inbox item, and the pending referral row (source link, no quote yet)', async () => {
    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, referralId: 'referral-1' });

    expect(createContact).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Sam Rivera', phone: '(516) 555-0123', tags: ['referral'] }),
    );

    expect(ingestTouch).toHaveBeenCalledTimes(1);
    const [touch] = ingestTouch.mock.calls[0];
    expect(touch.source).toBe('quotetool');
    expect(touch.subject).toContain('Jordan Smith');
    expect(touch.subject).toContain('Sam Rivera');

    expect(createPendingReferral).toHaveBeenCalledWith({
      source: 'link',
      referrerCustomerId: 'cust-1',
      refereeContactName: 'Sam Rivera',
      refereeContactEmail: 'sam@example.com',
      refereeContactPhone: '(516) 555-0123',
    });
  });

  it('skips the GHL contact create when HighLevel is not configured (fail-open)', async () => {
    hlConfigured.value = false;
    const res = await POST(makeReq(VALID_BODY));
    expect(res.status).toBe(200);
    expect(createContact).not.toHaveBeenCalled();
  });

  it('still succeeds when the GHL contact create throws (fail-open)', async () => {
    createContact.mockRejectedValueOnce(new Error('GHL down'));
    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it('still succeeds when the inbox ingest throws (fail-open)', async () => {
    ingestTouch.mockRejectedValueOnce(new Error('inbox table missing'));
    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
  });

  it('succeeds with a null referralId when createPendingReferral fails (never surfaces an internal DB error to the customer)', async () => {
    createPendingReferral.mockResolvedValueOnce(null);
    const res = await POST(makeReq(VALID_BODY));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toEqual({ ok: true, referralId: null });
  });

  it('works without an email (optional field)', async () => {
    const res = await POST(makeReq({ ...VALID_BODY, email: undefined }));
    expect(res.status).toBe(200);
    expect(createPendingReferral).toHaveBeenCalledWith(
      expect.objectContaining({ refereeContactEmail: null }),
    );
  });
});
