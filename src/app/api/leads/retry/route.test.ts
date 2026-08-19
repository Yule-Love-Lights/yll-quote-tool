// Tests for GET /api/leads/retry — the Vercel-cron batch pass that re-drives
// website_leads rows stuck 'pending'/'deferred' through the GHL sync. CRON-ONLY:
// guarded by Authorization: Bearer ${CRON_SECRET}. The retry orchestration itself
// (retryStuckLeads) is unit-tested in src/lib/leads/leadRetry.test.ts and mocked
// here — this file only covers the route's auth + config gating + delegation.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { retryStuckLeads } = vi.hoisted(() => ({ retryStuckLeads: vi.fn() }));
vi.mock('@/lib/leads/leadRetry', () => ({ retryStuckLeads }));

const { configured } = vi.hoisted(() => ({ configured: { current: true } }));
vi.mock('@/lib/supabase', () => ({
  isSupabaseServiceConfigured: () => configured.current,
}));

import { GET } from './route';

function req(auth?: string): NextRequest {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? auth ?? null : null) },
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  configured.current = true;
  process.env.CRON_SECRET = 'sekret';
  retryStuckLeads.mockResolvedValue({
    ok: true,
    processed: 2,
    synced: 1,
    deferred: 0,
    stillPending: 1,
    failed: 0,
  });
});

describe('GET /api/leads/retry (cron)', () => {
  it('401s without the correct bearer secret, never running the batch', async () => {
    const res = await GET(req('Bearer wrong'));
    expect(res.status).toBe(401);
    expect(retryStuckLeads).not.toHaveBeenCalled();
  });

  it('503s when CRON_SECRET is unset, so a dead cron is distinguishable', async () => {
    // Previously a 401, identical to a bad token — which is how the sibling
    // copilot project ran dark for 8+ days without anyone noticing (row 286).
    delete process.env.CRON_SECRET;
    const res = await GET(req('Bearer sekret'));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: 'CRON_SECRET is not configured on this deployment',
    });
    expect(retryStuckLeads).not.toHaveBeenCalled();
  });

  it('503s when the Supabase service role is not configured', async () => {
    configured.current = false;
    const res = await GET(req('Bearer sekret'));
    expect(res.status).toBe(503);
    expect(retryStuckLeads).not.toHaveBeenCalled();
  });

  it('runs the batch and returns its summary when the secret is present', async () => {
    const res = await GET(req('Bearer sekret'));
    expect(res.status).toBe(200);
    expect(retryStuckLeads).toHaveBeenCalledTimes(1);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, processed: 2, synced: 1, stillPending: 1 });
  });
});
