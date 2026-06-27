import { describe, it, expect } from 'vitest';
import { isPublicPath, hasValidOperatorAuth, safeEqual } from './operatorGate';

describe('isPublicPath — customer-facing allowlist', () => {
  it('treats the customer portal + its assets as public', () => {
    for (const p of [
      '/portal',
      '/portal/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60',
      '/portal/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60/approved',
      '/photos/abc.png',
      '/login',
    ]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it('treats customer-triggered quote APIs + webhooks as public', () => {
    for (const p of [
      '/api/quotes/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60/approve',
      '/api/quotes/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60/pay',
      '/api/quotes/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60/view',
      '/api/integrations/valor/webhook',
      '/api/integrations/homeworks/signed',
      '/api/login',
    ]) {
      expect(isPublicPath(p), p).toBe(true);
    }
  });

  it('gates every operator page + write API (default-deny)', () => {
    for (const p of [
      '/',
      '/customers',
      '/customers/contact_123',
      '/admin/quotes',
      '/settings',
      '/quote/new',
      '/training',
      '/insights',
      '/inventory',
      '/api/quotes', // list — PII
      '/api/settings',
      '/api/designs',
      '/api/designs/abc',
      '/api/training',
      '/api/save-correction',
      '/api/integrations/highlevel/contacts', // CRITICAL #2
      '/api/integrations/highlevel/attach',
      '/api/quotes/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60/send', // operator action
      '/api/quotes/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60/video', // operator-managed
      '/api/quotes/8f14e45f-ceea-467a-9f3a-1b2c3d4e5f60', // DELETE
    ]) {
      expect(isPublicPath(p), p).toBe(false);
    }
  });

  it('does not let a crafted path masquerade as a public sub-route', () => {
    // extra segments must not match the approve|pay|view rule
    expect(isPublicPath('/api/quotes/x/approve/extra')).toBe(false);
    expect(isPublicPath('/api/quotesX/y/approve')).toBe(false);
    expect(isPublicPath('/api/quotes/y/delete')).toBe(false);
  });
});

describe('hasValidOperatorAuth', () => {
  const SECRET = 'super-secret-value';

  it('accepts a valid header or cookie', () => {
    expect(hasValidOperatorAuth({ header: SECRET }, SECRET)).toBe(true);
    expect(hasValidOperatorAuth({ cookie: SECRET }, SECRET)).toBe(true);
  });

  it('rejects a wrong / missing credential', () => {
    expect(hasValidOperatorAuth({ header: 'nope' }, SECRET)).toBe(false);
    expect(hasValidOperatorAuth({ cookie: '' }, SECRET)).toBe(false);
    expect(hasValidOperatorAuth({}, SECRET)).toBe(false);
  });

  it('fails closed when the server secret is unset', () => {
    expect(hasValidOperatorAuth({ header: 'anything' }, undefined)).toBe(false);
    expect(hasValidOperatorAuth({ cookie: 'anything' }, '')).toBe(false);
  });
});

describe('safeEqual', () => {
  it('matches equal strings and rejects unequal (incl. length mismatch)', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
