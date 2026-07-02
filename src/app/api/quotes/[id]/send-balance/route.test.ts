// Tests for POST /api/quotes/[id]/send-balance (#83). Operator-only; sends the
// customer their balance pay-link via GHL SMS/email. No money moves. Supabase,
// jobs/invoices, GHL, auth, and the rate limiter are mocked; templates are real.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { type NextRequest } from 'next/server';

const {
  sbRef,
  requireOperatorMock,
  getJobByQuoteMock,
  getInvoiceByJobMock,
  isHighLevelConfiguredMock,
  sendSmsMock,
  sendEmailMock,
  rateLimitMock,
} = vi.hoisted(() => ({
  sbRef: { current: null as unknown },
  requireOperatorMock: vi.fn(async (): Promise<unknown> => null),
  getJobByQuoteMock: vi.fn(async (): Promise<unknown> => ({ id: 'job-1' })),
  getInvoiceByJobMock: vi.fn(async (): Promise<unknown> => ({ id: 'inv-1', status: 'awaiting_payment', balance: 2500 })),
  isHighLevelConfiguredMock: vi.fn(() => true),
  sendSmsMock: vi.fn(async (_i: { contactId: string; message: string; fromNumber?: string }) => ({ ok: true })),
  sendEmailMock: vi.fn(async (_i: { contactId: string; subject: string; html: string; emailFrom?: string }) => ({ ok: true })),
  rateLimitMock: vi.fn((): unknown => null),
}));

vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));
vi.mock('@/lib/rateLimit', () => ({ rateLimitResponse: rateLimitMock }));
vi.mock('@/lib/auth/supabaseServer', () => ({ requireOperator: requireOperatorMock }));
vi.mock('@/lib/jobs', () => ({ getJobByQuote: getJobByQuoteMock }));
vi.mock('@/lib/invoices', () => ({ getInvoiceByJob: getInvoiceByJobMock }));
vi.mock('@/lib/integrations/highlevel', () => ({
  isHighLevelConfigured: isHighLevelConfiguredMock,
  sendSms: sendSmsMock,
  sendEmail: sendEmailMock,
  HighLevelError: class HighLevelError extends Error {},
}));

import { POST } from './route';

const ID = '11111111-1111-1111-1111-111111111111';
const req = (body: unknown = {}) =>
  ({ nextUrl: { origin: 'https://portal.test' }, json: async () => body }) as unknown as NextRequest;
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

type Row = Record<string, unknown>;
function makeSb(quote: Row | null) {
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    from: () => b,
    select: () => b,
    eq: () => b,
    single: async () => ({ data: quote, error: quote ? null : { message: 'no rows' } }),
  });
  return b;
}

const QUOTE = { id: ID, highlevel_contact_id: 'contact-1', customer_name: 'Alice Smith', is_test: false };

beforeEach(() => {
  vi.clearAllMocks();
  requireOperatorMock.mockResolvedValue(null);
  rateLimitMock.mockReturnValue(null);
  isHighLevelConfiguredMock.mockReturnValue(true);
  getJobByQuoteMock.mockResolvedValue({ id: 'job-1' });
  getInvoiceByJobMock.mockResolvedValue({ id: 'inv-1', status: 'awaiting_payment', balance: 2500 });
  sendSmsMock.mockResolvedValue({ ok: true });
  sendEmailMock.mockResolvedValue({ ok: true });
  sbRef.current = makeSb(QUOTE);
});

describe('POST /api/quotes/[id]/send-balance', () => {
  it('returns the operator gate response when denied', async () => {
    const denied = { status: 401 };
    requireOperatorMock.mockResolvedValueOnce(denied);
    const res = await POST(req(), ctx());
    expect(res).toBe(denied);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it('400s on an invalid quote id', async () => {
    const res = await POST(req(), ctx('nope'));
    expect(res.status).toBe(400);
  });

  it('404s when the quote is missing', async () => {
    sbRef.current = makeSb(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
  });

  it('400s for a test quote (never messages a real customer)', async () => {
    sbRef.current = makeSb({ ...QUOTE, is_test: true });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.code).toBe('test-quote');
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it('409s when there is no invoice yet', async () => {
    getInvoiceByJobMock.mockResolvedValueOnce(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });

  it('409s when there is no balance due (already paid)', async () => {
    getInvoiceByJobMock.mockResolvedValueOnce({ id: 'inv-1', status: 'paid', balance: 0 });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('no-balance');
  });

  it('409s when the customer has no linked contact', async () => {
    sbRef.current = makeSb({ ...QUOTE, highlevel_contact_id: null });
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(409);
    expect(json.code).toBe('no-contact');
  });

  it('sends both SMS and email by default with the pay-balance link + exact balance', async () => {
    const res = await POST(req(), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ ok: true, smsSent: true, emailSent: true, channel: 'both', balanceUsd: 2500 });
    expect(sendSmsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'contact-1',
        message: expect.stringContaining(`/portal/${ID}/pay-balance`),
      }),
    );
    expect(sendSmsMock.mock.calls[0]?.[0]?.message).toContain('$2,500.00');
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('honours channel: sms only', async () => {
    const res = await POST(req({ channel: 'sms' }), ctx());
    const json = await res.json();
    expect(json.channel).toBe('sms');
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('reports a messageError but still 200s when GHL send throws', async () => {
    sendSmsMock.mockRejectedValueOnce(new Error('GHL 429'));
    const res = await POST(req({ channel: 'sms' }), ctx());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.smsSent).toBe(false);
    expect(json.messageError).toContain('GHL 429');
  });

  it('503s when GHL is not configured', async () => {
    isHighLevelConfiguredMock.mockReturnValueOnce(false);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(503);
    expect(sendSmsMock).not.toHaveBeenCalled();
  });
});
