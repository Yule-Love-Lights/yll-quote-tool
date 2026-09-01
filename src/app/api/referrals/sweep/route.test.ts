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

let infoSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  hlConfigured.value = true;
  sbConfigured.value = true;
  process.env.CRON_SECRET = SECRET;
  infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.REFERRAL_SWEEP_LIVE;
  infoSpy.mockRestore();
  errSpy.mockRestore();
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

  // Vercel Cron discards response bodies (verified in prod: 200s with zero log
  // output, so the dry-run numbers below used to be computed and thrown away
  // every run). These assert the summary is actually reaching console output,
  // and that a dry run and a live run read differently at a glance.
  describe('summary logging (Vercel Cron discards the response body)', () => {
    it('logs a dormant line when HighLevel is not configured, so a silent 200 is never ambiguous', async () => {
      hlConfigured.value = false;
      await GET(makeReq({ secret: SECRET }));
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('[referral-sweep] dormant'));
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('HighLevel not configured'));
    });

    it('logs a DRY RUN summary line with the real counts, tag breakdown, and resolved stage id', async () => {
      runReferralSweep.mockResolvedValue({
        ok: true,
        dryRun: true,
        scanned: 42,
        suppressed: 3,
        alreadyDone: 10,
        minted: 0,
        tagged: 0,
        taggedNeighbor: 0,
        taggedHasReferralLink: 0,
        wouldTagNeighbor: 8,
        wouldTagHasReferralLink: 4,
        errors: 0,
        errorSamples: [],
        sampleContacts: [],
        stoppedOn429: false,
        reachedEndOfList: true,
        resolvedDoNotCallStageId: 'stage-do-not-call-1',
      });
      await GET(makeReq({ secret: SECRET }));
      const line = (infoSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .find((l): l is string => typeof l === 'string' && l.startsWith('[referral-sweep]'));
      expect(line).toBeDefined();
      expect(line).toContain('DRY RUN');
      expect(line).not.toContain('LIVE');
      expect(line).toContain('scanned 42');
      expect(line).toContain('suppressed 3');
      expect(line).toContain('alreadyDone 10');
      expect(line).toContain('wouldMint 12');
      expect(line).toContain('neighbor 8');
      expect(line).toContain('has-referral-link 4');
      expect(line).toContain('errors 0');
      expect(line).toContain('stage-do-not-call-1');
    });

    it('logs a LIVE summary line that reads differently from a dry run at a glance', async () => {
      runReferralSweep.mockResolvedValue({
        ok: true,
        dryRun: false,
        scanned: 20,
        suppressed: 1,
        alreadyDone: 5,
        minted: 14,
        tagged: 14,
        taggedNeighbor: 6,
        taggedHasReferralLink: 8,
        wouldTagNeighbor: 0,
        wouldTagHasReferralLink: 0,
        errors: 0,
        errorSamples: [],
        sampleContacts: [],
        stoppedOn429: false,
        reachedEndOfList: true,
        resolvedDoNotCallStageId: 'stage-do-not-call-1',
      });
      await GET(makeReq({ secret: SECRET, url: 'https://quote.yulelovelights.com/api/referrals/sweep?live=true' }));
      const line = (infoSpy.mock.calls as unknown[][])
        .map((c) => c[0])
        .find((l): l is string => typeof l === 'string' && l.startsWith('[referral-sweep]'));
      expect(line).toBeDefined();
      expect(line).toContain('LIVE');
      expect(line).not.toContain('DRY RUN');
      expect(line).toContain('minted 14');
      expect(line).toContain('neighbor 6');
      expect(line).toContain('has-referral-link 8');
    });

    it('logs via console.error, with the error samples attached, when the run reports errors', async () => {
      runReferralSweep.mockResolvedValue({
        ok: true,
        dryRun: false,
        scanned: 5,
        suppressed: 0,
        alreadyDone: 0,
        minted: 2,
        tagged: 2,
        taggedNeighbor: 1,
        taggedHasReferralLink: 1,
        wouldTagNeighbor: 0,
        wouldTagHasReferralLink: 0,
        errors: 2,
        errorSamples: ['abc123: referral-link field stamp failed', 'def456: ensureReferralCode returned null'],
        sampleContacts: [],
        stoppedOn429: false,
        reachedEndOfList: true,
        resolvedDoNotCallStageId: 'stage-do-not-call-1',
      });
      await GET(makeReq({ secret: SECRET, url: 'https://quote.yulelovelights.com/api/referrals/sweep?live=true' }));
      const call = (errSpy.mock.calls as unknown[][]).find(
        (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('[referral-sweep]'),
      );
      expect(call).toBeDefined();
      expect(call?.[0]).toContain('errors 2');
      expect(call?.[1]).toEqual([
        'abc123: referral-link field stamp failed',
        'def456: ensureReferralCode returned null',
      ]);
    });

    it('logs an ABORTED line via console.error when the sweep reports ok:false, not just a thrown-away 500 body', async () => {
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
      await GET(makeReq({ secret: SECRET }));
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('ABORTED'));
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('Refusing to run: suppression stage id(s) not found live'),
      );
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('doNotCallStageId (unresolved)'));
    });
  });
});
