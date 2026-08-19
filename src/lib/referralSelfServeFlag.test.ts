// naldo/referral-self-serve, review fix 2. Same test shape as
// referralAutoAnalyze.test.ts's isReferralAutoAnalyzeEnabled block, its
// closer sibling flag.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isReferralSelfServeEnabled } from './referralSelfServeFlag';

const ORIGINAL_FLAG = process.env.REFERRAL_SELF_SERVE_ENABLED;

beforeEach(() => {
  delete process.env.REFERRAL_SELF_SERVE_ENABLED;
});

afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.REFERRAL_SELF_SERVE_ENABLED;
  else process.env.REFERRAL_SELF_SERVE_ENABLED = ORIGINAL_FLAG;
});

describe('isReferralSelfServeEnabled', () => {
  it('defaults OFF (unset)', () => {
    expect(isReferralSelfServeEnabled()).toBe(false);
  });

  it('is OFF for anything other than the literal string "true"', () => {
    process.env.REFERRAL_SELF_SERVE_ENABLED = '1';
    expect(isReferralSelfServeEnabled()).toBe(false);
    process.env.REFERRAL_SELF_SERVE_ENABLED = 'True';
    expect(isReferralSelfServeEnabled()).toBe(false);
    process.env.REFERRAL_SELF_SERVE_ENABLED = 'false';
    expect(isReferralSelfServeEnabled()).toBe(false);
  });

  it('is ON only for the literal string "true"', () => {
    process.env.REFERRAL_SELF_SERVE_ENABLED = 'true';
    expect(isReferralSelfServeEnabled()).toBe(true);
  });
});
