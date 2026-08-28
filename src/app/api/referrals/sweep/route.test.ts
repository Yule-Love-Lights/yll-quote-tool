import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import type { ReferralSweepSummary, ReferralSweepOptions } from '@/lib/referralSweep';

const { runReferralSweep, hlConfigured, sbConfigured } = vi.hoisted(() => ({
  runReferralSweep: vi.fn(async (_opts?: ReferralSweepOptions): Promise<ReferralSweepSummary> => ({
    ok: true,
    dryRun: true,
    scanned: 0,
    suppressed: 0,
    alreadyDone: 0,
    minted: 0,
    tagged: 0,
    taggedNeighbor: 0,
    taggedHasReferralLink: 0,
    wouldTagNeighbor: 0,
    wouldTagHasReferralLink: 0,
    errors: 0,
    errorSamples: [],
    sampleContacts: [],
    stoppedOn429: false,
    reachedEndOfList: true,
  })),
  hlConfigured: { value: true },
  sbConfigured: { value: true },
}));

vi.mock('@/lib/supabase', () => ({ isSupabaseServiceConfigured: () => sbConfigured.value }));
vi.mock('@/lib/integrations/highlevel', () => ({ isHighLevelConfigured: () => hlConfigured.value }));
vi.mock('@/lib/referralSweep', () => ({ runReferralSweep }));

import { GET } from './route';

const SECRET = 'cron-secret';
function makeReq(opts: { secret?: string; url?: string } = {}): NextRequest {
  const url = opts.url ?? 'https://quote.yulelovelights.com/api/referrals/sweep';
  return {
    headers: { get: (k: string) => (k.toLowerCase() === 'authorization' && opts.secret ? `Bearer ${opts.secret}` : null) },
    nextUrl: new URL(url),
  } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  hlConfigured.value = true;
  sbConfigured.value = true;
  process.env.CRON_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.REFERRAL_SWEEP_LIVE;
});

describe('GET /api/referrals/sweep', () => {
  it('401s without the cron secret and never calls the sweep', async () => {
    const res = await GET(makeReq({ secret: 'wrong' }));
    expect(res.status).toBe(401);
    expect(runReferralSweep).not.toHaveBeenCalled();
  });

  it('503s (naming the missing variable) when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeReq({ secret: SECRET }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain('CRON_SECRET');
    expect(runReferralSweep).not.toHaveBeenCalled();
  });

  it('is dormant (200, skipped) when HighLevel is not configured, never calls the sweep', async () => {
    hlConfigured.value = false;
    const res = await GET(makeReq({ secret: SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBeTruthy();
    expect(runReferralSweep).not.toHaveBeenCalled();
  });

  it('503s when Supabase service role is not configured', async () => {
    sbConfigured.value = false;
    const res = await GET(makeReq({ secret: SECRET }));
    expect(res.status).toBe(503);
    expect(runReferralSweep).not.toHaveBeenCalled();
  });

  it('DEFAULTS to a dry run: a bare authorized hit with no query string never goes live', async () => {
    await GET(makeReq({ secret: SECRET }));
    expect(runReferralSweep).toHaveBeenCalledWith({ dryRun: true });
  });

  it('stays a dry run for any query string OTHER than exactly ?live=true', async () => {
    await GET(makeReq({ secret: SECRET, url: 'https://quote.yulelovelights.com/api/referrals/sweep?live=1' }));
    expect(runReferralSweep).toHaveBeenCalledWith({ dryRun: true });

    vi.clearAllMocks();
    await GET(makeReq({ secret: SECRET, url: 'https://quote.yulelovelights.com/api/referrals/sweep?live=false' }));
    expect(runReferralSweep).toHaveBeenCalledWith({ dryRun: true });
  });

  it('goes LIVE only with the exact ?live=true query param', async () => {
    await GET(makeReq({ secret: SECRET, url: 'https://quote.yulelovelights.com/api/referrals/sweep?live=true' }));
    expect(runReferralSweep).toHaveBeenCalledWith({ dryRun: false });
  });

  it('goes LIVE when REFERRAL_SWEEP_LIVE=true is set, even with no query string: the standing switch the real cron relies on', async () => {
    process.env.REFERRAL_SWEEP_LIVE = 'true';
    await GET(makeReq({ secret: SECRET }));
    expect(runReferralSweep).toHaveBeenCalledWith({ dryRun: false });
    delete process.env.REFERRAL_SWEEP_LIVE;
  });

  it('stays a dry run for any other REFERRAL_SWEEP_LIVE value', async () => {
    process.env.REFERRAL_SWEEP_LIVE = 'yes';
    await GET(makeReq({ secret: SECRET }));
    expect(runReferralSweep).toHaveBeenCalledWith({ dryRun: true });
    delete process.env.REFERRAL_SWEEP_LIVE;
  });

  it('is dormant/unset by default: REFERRAL_SWEEP_LIVE is not set at all in a fresh environment', async () => {
    expect(process.env.REFERRAL_SWEEP_LIVE).toBeUndefined();
    await GET(makeReq({ secret: SECRET }));
    expect(runReferralSweep).toHaveBeenCalledWith({ dryRun: true });
  });

  it('returns the sweep summary with a 200 when ok', async () => {
    const res = await GET(makeReq({ secret: SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('returns the sweep summary with a 500 when the sweep itself reports not-ok (e.g. the fail-loud suppression check)', async () => {
    runReferralSweep.mockResolvedValue({
      ok: false,
      dryRun: true,
      scanned: 0,
      suppressed: 0,
      alreadyDone: 0,
      minted: 0,
      tagged: 0,
      taggedNeighbor: 0,
      taggedHasReferralLink: 0,
      wouldTagNeighbor: 0,
      wouldTagHasReferralLink: 0,
      errors: 0,
      errorSamples: [],
      sampleContacts: [],
      stoppedOn429: false,
      reachedEndOfList: false,
      error: 'Refusing to run: suppression stage id(s) not found live',
    });
    const res = await GET(makeReq({ secret: SECRET }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain('Refusing to run');
  });
});
