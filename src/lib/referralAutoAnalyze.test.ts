// Tests for the #41 V2 referral auto-analyze guard rails. Mocks every real
// dependency (rate limiter, Claude/Maps config checks, imagery fetch, the
// analyzer) so these tests never touch real env vars, network, or .env.local
// — vitest must not depend on real config.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

const {
  checkRateLimit,
  checkRateLimitByKey,
  isClaudeConfigured,
  isGoogleMapsConfigured,
  getCachedAddressImagery,
  runAnalyzeWithFewShot,
  NoStreetViewErrorMock,
} = vi.hoisted(() => ({
  checkRateLimit: vi.fn(() => ({ ok: true, remaining: 2, resetMs: 1000 })),
  checkRateLimitByKey: vi.fn(() => ({ ok: true, remaining: 2, resetMs: 1000 })),
  isClaudeConfigured: vi.fn(() => true),
  isGoogleMapsConfigured: vi.fn(() => true),
  getCachedAddressImagery: vi.fn(),
  runAnalyzeWithFewShot: vi.fn(),
  NoStreetViewErrorMock: class NoStreetViewError extends Error {},
}));

vi.mock('./rateLimit', () => ({ checkRateLimit, checkRateLimitByKey }));
vi.mock('./claude', () => ({ isClaudeConfigured }));
vi.mock('./googleMaps', () => ({
  isGoogleMapsConfigured,
  getCachedAddressImagery,
  NoStreetViewError: NoStreetViewErrorMock,
}));
vi.mock('./analyzeWithFewShot', () => ({ runAnalyzeWithFewShot }));

import {
  isReferralAutoAnalyzeEnabled,
  looksLikeRealAddress,
  maybeRunReferralAutoAnalyze,
  __resetReferralAutoAnalyzeState,
} from './referralAutoAnalyze';

const ADDRESS = '123 Main St, Smithtown, NY';
const CODE = 'ABCD1234';

function fakeReq(): NextRequest {
  return { headers: new Headers({ 'x-forwarded-for': '5.5.5.5' }) } as unknown as NextRequest;
}

const IMAGERY = {
  geo: { lat: 1.1, lng: 2.2, formattedAddress: '123 Main St, Smithtown, NY 11787' },
  streetView: { base64: 'street-b64', mediaType: 'image/jpeg' as const },
  satellite: { base64: 'sat-b64', mediaType: 'image/png' as const },
  satelliteFeetPerPixel: 0.5,
  panoLocation: { lat: 1.1001, lng: 2.2001 },
};

const ANALYSIS_RESULT = {
  santasFootage: 42.4,
  santasDifficulty: 'medium' as const,
  santasLines: [{ points: [[0.1, 0.2], [0.3, 0.4]] as [number, number][], label: 'front roofline ~42ft' }],
  gingerbreadFootage: 0,
  gingerbreadDifficulty: 'easy' as const,
  gingerbreadLines: [],
  satelliteSantasLines: [],
  satelliteSantasFootage: 0,
  satelliteGingerbreadLines: [],
  satelliteGingerbreadFootage: 0,
  preferredSource: 'street' as const,
  miniLightDetections: [],
  wreathDetections: [],
  spritzerDetections: [],
  garlandDetections: [],
  notes: '',
  confidence: 'high' as const,
};

const ORIGINAL_FLAG = process.env.REFERRAL_AUTO_ANALYZE_ENABLED;

beforeEach(() => {
  vi.clearAllMocks();
  __resetReferralAutoAnalyzeState();
  checkRateLimit.mockReturnValue({ ok: true, remaining: 2, resetMs: 1000 });
  checkRateLimitByKey.mockReturnValue({ ok: true, remaining: 2, resetMs: 1000 });
  isClaudeConfigured.mockReturnValue(true);
  isGoogleMapsConfigured.mockReturnValue(true);
  getCachedAddressImagery.mockResolvedValue(IMAGERY);
  runAnalyzeWithFewShot.mockResolvedValue({
    result: ANALYSIS_RESULT,
    analysisUnavailable: false,
    analysisError: undefined,
    fewShotCount: 0,
    fewShotBreakdown: undefined,
  });
  process.env.REFERRAL_AUTO_ANALYZE_ENABLED = 'true';
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.REFERRAL_AUTO_ANALYZE_ENABLED;
  else process.env.REFERRAL_AUTO_ANALYZE_ENABLED = ORIGINAL_FLAG;
});

describe('isReferralAutoAnalyzeEnabled', () => {
  it('defaults OFF (unset)', () => {
    delete process.env.REFERRAL_AUTO_ANALYZE_ENABLED;
    expect(isReferralAutoAnalyzeEnabled()).toBe(false);
  });
  it('is OFF for anything other than the literal string "true"', () => {
    process.env.REFERRAL_AUTO_ANALYZE_ENABLED = '1';
    expect(isReferralAutoAnalyzeEnabled()).toBe(false);
    process.env.REFERRAL_AUTO_ANALYZE_ENABLED = 'True';
    expect(isReferralAutoAnalyzeEnabled()).toBe(false);
  });
  it('is ON only for the literal string "true"', () => {
    process.env.REFERRAL_AUTO_ANALYZE_ENABLED = 'true';
    expect(isReferralAutoAnalyzeEnabled()).toBe(true);
  });
});

describe('looksLikeRealAddress', () => {
  it('accepts a normal street address', () => {
    expect(looksLikeRealAddress('123 Main St, Smithtown, NY')).toBe(true);
  });
  it('rejects empty / whitespace-only input', () => {
    expect(looksLikeRealAddress('')).toBe(false);
    expect(looksLikeRealAddress('   ')).toBe(false);
  });
  it('rejects a single word with no house number', () => {
    expect(looksLikeRealAddress('asdfasdf')).toBe(false);
  });
  it('rejects a bare number with no street name', () => {
    expect(looksLikeRealAddress('123')).toBe(false);
  });
  it('rejects text with no digit at all', () => {
    expect(looksLikeRealAddress('Main Street Smithtown')).toBe(false);
  });
});

describe('maybeRunReferralAutoAnalyze — flag OFF (default, ships dormant)', () => {
  it('returns null and touches none of the paid dependencies when the flag is unset', async () => {
    delete process.env.REFERRAL_AUTO_ANALYZE_ENABLED;
    const result = await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
    expect(result).toBeNull();
    expect(getCachedAddressImagery).not.toHaveBeenCalled();
    expect(runAnalyzeWithFewShot).not.toHaveBeenCalled();
    expect(checkRateLimit).not.toHaveBeenCalled();
  });
});

describe('maybeRunReferralAutoAnalyze — flag ON', () => {
  it('returns a preview payload on a successful analyze', async () => {
    const result = await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
    expect(result).toEqual({
      photoDataUrl: 'data:image/jpeg;base64,street-b64',
      formattedAddress: '123 Main St, Smithtown, NY 11787',
      footageEstimate: 42,
      lines: ANALYSIS_RESULT.santasLines,
    });
  });

  it('skips (returns null) when the address does not look real, without spending anything', async () => {
    const result = await maybeRunReferralAutoAnalyze(fakeReq(), CODE, 'asdf');
    expect(result).toBeNull();
    expect(getCachedAddressImagery).not.toHaveBeenCalled();
  });

  it('skips when Claude is not configured', async () => {
    isClaudeConfigured.mockReturnValue(false);
    const result = await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
    expect(result).toBeNull();
    expect(getCachedAddressImagery).not.toHaveBeenCalled();
  });

  it('skips when Google Maps is not configured', async () => {
    isGoogleMapsConfigured.mockReturnValue(false);
    const result = await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
    expect(result).toBeNull();
    expect(getCachedAddressImagery).not.toHaveBeenCalled();
  });

  it('fails open (returns null, never throws) when imagery fetch throws', async () => {
    getCachedAddressImagery.mockRejectedValueOnce(new Error('Google down'));
    const result = await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
    expect(result).toBeNull();
  });

  it('fails open when there is no Street View coverage for the address', async () => {
    getCachedAddressImagery.mockRejectedValueOnce(new NoStreetViewErrorMock('no coverage'));
    const result = await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
    expect(result).toBeNull();
  });

  it('fails open when the analyzer returns no result (its own fail-safe path)', async () => {
    runAnalyzeWithFewShot.mockResolvedValueOnce({
      result: null,
      analysisUnavailable: true,
      analysisError: 'unavailable',
      fewShotCount: 0,
      fewShotBreakdown: undefined,
    });
    const result = await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
    expect(result).toBeNull();
  });

  describe('caps (guard a)', () => {
    it('skips when the per-IP daily cap is reached, without calling the per-code check', async () => {
      checkRateLimit.mockReturnValue({ ok: false, remaining: 0, resetMs: 1000 });
      const result = await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
      expect(result).toBeNull();
      expect(checkRateLimitByKey).not.toHaveBeenCalled();
      expect(getCachedAddressImagery).not.toHaveBeenCalled();
    });

    it('skips when the per-code daily cap is reached', async () => {
      checkRateLimitByKey.mockReturnValue({ ok: false, remaining: 0, resetMs: 1000 });
      const result = await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
      expect(result).toBeNull();
      expect(getCachedAddressImagery).not.toHaveBeenCalled();
    });

    it('checks the per-IP cap using the analyze-specific bucket, separate from the submit rate limit', async () => {
      await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
      expect(checkRateLimit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ bucket: 'referral-auto-analyze-ip' }),
      );
    });

    it('checks the per-code cap keyed off the referral code, in its own bucket', async () => {
      await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
      expect(checkRateLimitByKey).toHaveBeenCalledWith(
        expect.stringContaining(CODE),
        expect.objectContaining({ bucket: 'referral-auto-analyze-code' }),
      );
    });
  });

  describe('dedupe (guard b)', () => {
    it('never analyzes the same code+address pair twice', async () => {
      const first = await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
      expect(first).not.toBeNull();
      expect(getCachedAddressImagery).toHaveBeenCalledTimes(1);

      const second = await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
      expect(second).toBeNull();
      expect(getCachedAddressImagery).toHaveBeenCalledTimes(1);
    });

    it('marks the pair attempted BEFORE calling the analyzer, so a failed attempt cannot be retried for free', async () => {
      getCachedAddressImagery.mockRejectedValueOnce(new Error('down'));
      const first = await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
      expect(first).toBeNull();

      const second = await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
      expect(second).toBeNull();
      // Only the first call actually reached the imagery fetch — the retry
      // was blocked by dedupe, not attempted again.
      expect(getCachedAddressImagery).toHaveBeenCalledTimes(1);
    });

    it('allows the SAME address for a DIFFERENT code', async () => {
      const first = await maybeRunReferralAutoAnalyze(fakeReq(), CODE, ADDRESS);
      expect(first).not.toBeNull();
      const second = await maybeRunReferralAutoAnalyze(fakeReq(), 'OTHERCODE', ADDRESS);
      expect(second).not.toBeNull();
      expect(getCachedAddressImagery).toHaveBeenCalledTimes(2);
    });
  });
});
