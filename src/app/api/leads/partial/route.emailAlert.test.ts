// Focused tests for the staff email alert added to POST /api/leads/partial.
// Kept separate from route.test.ts (mirrors the full-lead route's
// route.telegram.test.ts pattern): that file exercises validation/dedupe/
// rate-limit/GHL with sendLeadAlertEmail unmocked-but-dormant (no contact env
// set); here the alert seam itself is mocked and asserted. No Telegram call
// exists on this route by design (partial leads are lower-intent).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { sendLeadAlertEmail, isHighLevelConfigured } = vi.hoisted(() => ({
  sendLeadAlertEmail: vi.fn<(lead: unknown, opts: unknown) => Promise<'sent' | 'skipped'>>(async () => 'sent'),
  isHighLevelConfigured: vi.fn(() => true),
}));

vi.mock('@/lib/leads/leadAlerts', () => ({ sendLeadAlertEmail }));
vi.mock('@/lib/leads/partialLead', () => ({
  syncPartialLeadToGhl: vi.fn(async () => ({ status: 'synced', ghlContactId: 'contact-1' })),
}));
vi.mock('@/lib/integrations/highlevel', () => ({ isHighLevelConfigured }));

const { sbRef } = vi.hoisted(() => ({ sbRef: { current: null as unknown } }));
vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => true,
  getSupabaseServiceClient: () => sbRef.current,
}));

import { POST } from './route';

// Same minimal fake Supabase shape as route.test.ts's makeSb happy path.
function makeSb() {
  const inserted: Record<string, unknown>[] = [];
  let mode: 'count' | 'insert' | 'write' | null = null;
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    from: () => builder,
    select: (_c: string, o?: { head?: boolean }) => {
      if (o?.head) mode = 'count';
      return builder;
    },
    insert: (p: Record<string, unknown>) => {
      mode = 'insert';
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
    single: async () => ({ data: { id: 'partial-1' }, error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
    then: (resolve: (v: unknown) => unknown) =>
      resolve(mode === 'count' ? { count: 0, error: null } : { error: null }),
  });
  return { builder, inserted };
}

function makeReq(body: Record<string, unknown>): NextRequest {
  return {
    headers: { get: () => null },
    text: async () => JSON.stringify(body),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  isHighLevelConfigured.mockReturnValue(true);
  sbRef.current = makeSb().builder;
});

describe('POST /api/leads/partial — staff email alert', () => {
  it('sends the alert email once for a real partial capture, with partial:true', async () => {
    const res = await POST(
      makeReq({ name: 'Jordan Partial', email: 'jordan@example.com', phone: '5551234567', service: 'permanent' }),
    );
    expect(res.status).toBe(200);
    expect(sendLeadAlertEmail).toHaveBeenCalledTimes(1);
    const [lead, opts] = sendLeadAlertEmail.mock.calls[0]!;
    expect(opts).toEqual({ partial: true });
    expect(lead).toMatchObject({
      name: 'Jordan Partial',
      email: 'jordan@example.com',
      phone: '5551234567',
      service: 'permanent',
    });
  });

  it('does not send when there is no usable contact handle (no-op skip)', async () => {
    const res = await POST(makeReq({ name: 'Lone Name' }));
    expect(res.status).toBe(200);
    expect(sendLeadAlertEmail).not.toHaveBeenCalled();
  });

  it('stays silent for a honeypot (spam) submission', async () => {
    const { builder, inserted } = makeSb();
    sbRef.current = builder;
    const res = await POST(
      makeReq({ email: 'jane@example.com', phone: '5551234567', company: 'definitely a bot' }),
    );
    expect(res.status).toBe(200);
    expect(sendLeadAlertEmail).not.toHaveBeenCalled();
    expect(inserted[0]?.sync_status).toBe('spam');
  });

  it('stays silent for an isTest capture (matches the full-lead route gating)', async () => {
    const res = await POST(
      makeReq({ name: 'Test Capture', email: 'test@example.com', phone: '5551234567', isTest: true }),
    );
    expect(res.status).toBe(200);
    expect(sendLeadAlertEmail).not.toHaveBeenCalled();
  });

  it('a slow email send does not hang the request past the 2s best-effort cap', async () => {
    vi.useFakeTimers();
    try {
      sendLeadAlertEmail.mockImplementationOnce(() => new Promise(() => {})); // never resolves
      const promise = POST(makeReq({ email: 'jane@example.com', phone: '5551234567' }));
      await vi.advanceTimersByTimeAsync(2000);
      const res = await promise;
      expect(res.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
