// Tests for the login page's redirect-target guard (WT-61 — open redirect).
// A bare `from.startsWith('/')` check also passes a protocol-relative URL
// ("//evil.com/x"), which the browser treats as scheme-relative and navigates
// cross-origin. Only a single-leading-slash path is safe.

import { describe, it, expect } from 'vitest';
import { isSafeRedirectTarget } from './page';

describe('isSafeRedirectTarget', () => {
  it('allows a normal same-origin path', () => {
    expect(isSafeRedirectTarget('/admin/quotes')).toBe(true);
  });

  it('allows the root path', () => {
    expect(isSafeRedirectTarget('/')).toBe(true);
  });

  it('allows a path with a query string', () => {
    expect(isSafeRedirectTarget('/admin/quotes?id=123')).toBe(true);
  });

  it('rejects a protocol-relative redirect', () => {
    expect(isSafeRedirectTarget('//evil.com/x')).toBe(false);
  });

  it('rejects a protocol-relative redirect with extra slashes', () => {
    expect(isSafeRedirectTarget('///evil.com')).toBe(false);
  });

  it('rejects an absolute URL', () => {
    expect(isSafeRedirectTarget('https://evil.com')).toBe(false);
  });

  it('rejects a path that does not start with a slash', () => {
    expect(isSafeRedirectTarget('evil.com')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isSafeRedirectTarget('')).toBe(false);
  });
});
