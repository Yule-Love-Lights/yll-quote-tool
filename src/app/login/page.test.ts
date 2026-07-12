// WT-61: `from.startsWith('/')` alone let a protocol-relative value like
// `//evil.com/x` through — the browser reads a leading `//` as "same scheme,
// different host", so router.replace(from) would navigate off-origin (open
// redirect / phishing). safeRedirectTarget rejects that case and falls back
// to '/'.

import { describe, it, expect } from 'vitest';
import { safeRedirectTarget } from './page';

describe('safeRedirectTarget', () => {
  it('allows a same-origin path', () => {
    expect(safeRedirectTarget('/inbox')).toBe('/inbox');
  });

  it('rejects a protocol-relative //host value, falling back to /', () => {
    expect(safeRedirectTarget('//evil.com/x')).toBe('/');
  });

  it('rejects a value with no leading slash, falling back to /', () => {
    expect(safeRedirectTarget('evil.com')).toBe('/');
  });

  it('rejects an absolute URL, falling back to /', () => {
    expect(safeRedirectTarget('https://evil.com')).toBe('/');
  });
});
