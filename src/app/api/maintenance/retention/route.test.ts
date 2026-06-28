// #90 PII-retention cron. CRON-only (CRON_SECRET-guarded); purges abandoned
// designs via purgeAbandonedDesigns. The purge logic is unit-tested in
// designs.test.ts — here we pin the auth guard + that it calls the purge.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const { purge } = vi.hoisted(() => ({
  purge: vi.fn(async () => ({ scanned: 2, purged: 2 })),
}));

vi.mock('@/lib/designs', () => ({ purgeAbandonedDesigns: purge }));
vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => true }));

import { GET } from './route';

function makeReq(auth?: string): NextRequest {
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'authorization' ? auth ?? null : null) },
  } as unknown as NextRequest;
}

const OLD_SECRET = process.env.CRON_SECRET;
beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = 'test-secret';
});
afterEach(() => {
  if (OLD_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = OLD_SECRET;
});

describe('GET /api/maintenance/retention (#90 cron)', () => {
  it('401s without the cron secret', async () => {
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    expect(purge).not.toHaveBeenCalled();
  });

  it('401s with a wrong secret', async () => {
    const res = await GET(makeReq('Bearer nope'));
    expect(res.status).toBe(401);
    expect(purge).not.toHaveBeenCalled();
  });

  it('purges with the 90-day window and returns counts when authorized', async () => {
    const res = await GET(makeReq('Bearer test-secret'));
    expect(res.status).toBe(200);
    expect(purge).toHaveBeenCalledWith(90);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, designs: { scanned: 2, purged: 2 } });
  });
});
