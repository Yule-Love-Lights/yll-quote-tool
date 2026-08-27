import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { stateMatches, portalBaseUrl, OAUTH_STATE_COOKIE } from './bouncieOAuthState';

let prev: string | undefined;
beforeEach(() => { prev = process.env.PORTAL_BASE_URL; });
afterEach(() => {
  if (prev === undefined) delete process.env.PORTAL_BASE_URL; else process.env.PORTAL_BASE_URL = prev;
});

describe('stateMatches', () => {
  const state = 'a-random-state-value-abcdefghijklmnop';

  it('accepts the value we issued', () => {
    expect(stateMatches(state, state)).toBe(true);
  });

  it('rejects a different value', () => {
    expect(stateMatches(state, `${state}x`)).toBe(false);
    expect(stateMatches('other', state)).toBe(false);
  });

  // Fails closed: a callback with no cookie is a stale flow or a forged one, and
  // neither should be able to store a fleet-wide credential.
  it('rejects a MISSING cookie, which is the CSRF case', () => {
    expect(stateMatches(state, undefined)).toBe(false);
    expect(stateMatches(state, null)).toBe(false);
    expect(stateMatches(state, '')).toBe(false);
  });

  it('rejects a missing query value', () => {
    expect(stateMatches(undefined, state)).toBe(false);
    expect(stateMatches('', state)).toBe(false);
  });

  it('rejects when BOTH are absent, rather than treating empty as equal', () => {
    expect(stateMatches(undefined, undefined)).toBe(false);
    expect(stateMatches('', '')).toBe(false);
  });
});

describe('portalBaseUrl', () => {
  it('uses PORTAL_BASE_URL when set, matching the repo pattern', () => {
    process.env.PORTAL_BASE_URL = 'https://staging.example.com';
    expect(portalBaseUrl()).toBe('https://staging.example.com');
  });

  it('strips trailing slashes so joined paths do not double up', () => {
    process.env.PORTAL_BASE_URL = 'https://example.com///';
    expect(portalBaseUrl()).toBe('https://example.com');
  });

  it('falls back to the production host', () => {
    delete process.env.PORTAL_BASE_URL;
    expect(portalBaseUrl()).toBe('https://quote.yulelovelights.com');
  });

  it('does not derive the origin from a request, so a forged Host cannot steer it', () => {
    // The whole reason this helper exists rather than req.nextUrl.origin.
    delete process.env.PORTAL_BASE_URL;
    expect(portalBaseUrl()).not.toContain('attacker');
  });
});

describe('the cookie name is shared, not duplicated', () => {
  it('is a single exported constant', () => {
    // Start route and callback must agree; a drift here presents as "the grant
    // silently never completes", which nobody diagnoses quickly.
    expect(OAUTH_STATE_COOKIE).toBe('bouncie_oauth_state');
  });
});
