// Focused tests for the Phase-1 new-lead Telegram ping + staff email alert in
// POST /api/leads (2026-07-19 text-ops plan; email alert added on top of it).
// Kept separate from route.test.ts: that file exercises validation/spam/
// rate-limit/GHL with these two notification seams running real-but-dormant;
// here both seams are mocked and asserted. newLeadMessage runs REAL so the
// Telegram message content is genuinely exercised.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { notifyTelegramAudience, sendLeadAlertEmail, syncLeadToGhl } = vi.hoisted(() => ({
  notifyTelegramAudience: vi.fn<(audience: string, text: string) => Promise<void>>(async () => {}),
  sendLeadAlertEmail: vi.fn<(lead: unknown, opts: unknown) => Promise<'sent' | 'skipped'>>(async () => 'sent'),
  syncLeadToGhl: vi.fn(async () => ({
    status: 'synced' as const,
    ghlContactId: 'c1',
    ghlOpportunityId: 'o1',
  })),
}));

vi.mock('@/lib/integrations/telegramNotify', () => ({
  appBaseUrl: () => 'https://quote.yulelovelights.com',
}));
vi.mock('@/lib/integrations/telegramRouting', () => ({ notifyTelegramAudience }));
vi.mock('@/lib/leads/leadAlerts', () => ({ sendLeadAlertEmail }));
vi.mock('@/lib/leads/leadService', () => ({
  LEAD_SERVICES: ['christmas'],
  asLeadService: (v: unknown) => (v === 'christmas' ? 'christmas' : null),
  syncLeadToGhl,
}));
vi.mock('@/lib/integrations/highlevel', () => ({
  HighLevelError: class FakeHighLevelError extends Error {},
}));

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

import { POST } from './route';

// Minimal fake Supabase builder for the happy path: count queries (dedupe /
// rate-limit) resolve to 0, insert().select().single() returns an id, awaited
// bare inserts/updates resolve to { error: null }.
function makeSb() {
  const inserted: Record<string, unknown>[] = [];
  let mode: 'count' | 'write' | null = null;
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: (_c: string, o?: { head?: boolean }) => {
      if (o?.head) mode = 'count';
      return builder;
    },
    insert: (p: Record<string, unknown>) => {
      mode = 'write';
      inserted.push(p);
      return builder;
    },
    update: () => {
      mode = 'write';
      return builder;
    },
    eq: () => builder,
    in: () => builder,
    gte: () => builder,
    not: () => builder,
    single: async () => ({ data: { id: 'lead-1' }, error: null }),
    then: (resolve: (v: unknown) => unknown) =>
      resolve(mode === 'count' ? { count: 0, error: null } : { error: null }),
  });
  return { builder, inserted };
}

function makeReq(body: Record<string, unknown>): NextRequest {
  return {
    headers: { get: () => null },
    json: async () => body,
  } as unknown as NextRequest;
}

const validLead = {
  name: 'Jordan Lead',
  email: 'jordan@example.com',
  phone: '+16315551234',
  service: 'christmas',
  formVariant: 'bar',
  consent: true,
  address: '12 Candy Cane Ln',
  elapsedMs: 5000,
};

beforeEach(() => {
  vi.clearAllMocks();
  sbRef.current = makeSb().builder;
});

describe('POST /api/leads — new-lead Telegram ping', () => {
  it('pings once for a real lead, with name + service + admin link, routed to the leads audience', async () => {
    const res = await POST(makeReq(validLead));
    expect(res.status).toBe(200);
    expect(notifyTelegramAudience).toHaveBeenCalledTimes(1);
    const [audience, msg] = notifyTelegramAudience.mock.calls[0]!;
    expect(audience).toBe('leads');
    expect(msg).toContain('🟢 New website lead — Jordan Lead (christmas)');
    expect(msg).toContain('📞 +16315551234');
    expect(msg).toContain('📍 12 Candy Cane Ln');
    expect(msg).toContain('Leads → https://quote.yulelovelights.com/admin/leads');
  });

  it('stays silent for a test lead', async () => {
    const res = await POST(makeReq({ ...validLead, isTest: true }));
    expect(res.status).toBe(200);
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
  });

  it('stays silent for a honeypot (spam) submission', async () => {
    const { builder, inserted } = makeSb();
    sbRef.current = builder;
    const res = await POST(makeReq({ ...validLead, company: 'definitely a bot' }));
    expect(res.status).toBe(200);
    expect(notifyTelegramAudience).not.toHaveBeenCalled();
    expect(inserted[0]?.sync_status).toBe('spam');
  });
});

describe('POST /api/leads — new-lead staff email alert', () => {
  it('sends the alert email once for a real lead, non-partial, with the full lead payload', async () => {
    const res = await POST(makeReq(validLead));
    expect(res.status).toBe(200);
    expect(sendLeadAlertEmail).toHaveBeenCalledTimes(1);
    const [lead, opts] = sendLeadAlertEmail.mock.calls[0]!;
    expect(opts).toEqual({ partial: false });
    expect(lead).toMatchObject({
      name: 'Jordan Lead',
      email: 'jordan@example.com',
      phone: '+16315551234',
      address: '12 Candy Cane Ln',
      service: 'christmas',
      formVariant: 'bar',
    });
  });

  it('stays silent for a test lead (same gating as the Telegram ping)', async () => {
    const res = await POST(makeReq({ ...validLead, isTest: true }));
    expect(res.status).toBe(200);
    expect(sendLeadAlertEmail).not.toHaveBeenCalled();
  });

  it('stays silent for a honeypot (spam) submission (same gating as the Telegram ping)', async () => {
    const { builder } = makeSb();
    sbRef.current = builder;
    const res = await POST(makeReq({ ...validLead, company: 'definitely a bot' }));
    expect(res.status).toBe(200);
    expect(sendLeadAlertEmail).not.toHaveBeenCalled();
  });

  it('a slow email send does not hang the request past the 2s best-effort cap', async () => {
    vi.useFakeTimers();
    try {
      sendLeadAlertEmail.mockImplementationOnce(() => new Promise(() => {})); // never resolves
      const promise = POST(makeReq(validLead));
      await vi.advanceTimersByTimeAsync(2000);
      const res = await promise;
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
