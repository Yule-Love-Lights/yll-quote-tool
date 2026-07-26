// Focused tests for the Phase-1 new-lead Telegram ping in POST /api/leads
// (2026-07-19 text-ops plan). Kept separate from route.test.ts: that file
// exercises validation/spam/rate-limit/GHL with the notifyTelegram import
// running real-but-dormant; here the ping seam itself is mocked and asserted.
// newLeadMessage runs REAL so the message content is genuinely exercised.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { notifyTelegram, syncLeadToGhl } = vi.hoisted(() => ({
  notifyTelegram: vi.fn<(text: string) => Promise<void>>(async () => {}),
  syncLeadToGhl: vi.fn(async () => ({
    status: 'synced' as const,
    ghlContactId: 'c1',
    ghlOpportunityId: 'o1',
  })),
}));

vi.mock('@/lib/integrations/telegramNotify', () => ({
  notifyTelegram,
  appBaseUrl: () => 'https://quote.yulelovelights.com',
}));
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
  it('pings once for a real lead, with name + service + admin link', async () => {
    const res = await POST(makeReq(validLead));
    expect(res.status).toBe(200);
    expect(notifyTelegram).toHaveBeenCalledTimes(1);
    const msg = notifyTelegram.mock.calls[0][0];
    expect(msg).toContain('🟢 New website lead — Jordan Lead (christmas)');
    expect(msg).toContain('📞 +16315551234');
    expect(msg).toContain('📍 12 Candy Cane Ln');
    expect(msg).toContain('Leads → https://quote.yulelovelights.com/admin/leads');
  });

  it('stays silent for a test lead', async () => {
    const res = await POST(makeReq({ ...validLead, isTest: true }));
    expect(res.status).toBe(200);
    expect(notifyTelegram).not.toHaveBeenCalled();
  });

  it('stays silent for a honeypot (spam) submission', async () => {
    const { builder, inserted } = makeSb();
    sbRef.current = builder;
    const res = await POST(makeReq({ ...validLead, company: 'definitely a bot' }));
    expect(res.status).toBe(200);
    expect(notifyTelegram).not.toHaveBeenCalled();
    expect(inserted[0]?.sync_status).toBe('spam');
  });
});
