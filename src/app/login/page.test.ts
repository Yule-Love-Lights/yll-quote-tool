// WT-61: `from.startsWith('/')` alone let a protocol-relative value like
// `//evil.com/x` through — the browser reads a leading `//` as "same scheme,
// different host", so router.replace(from) would navigate off-origin (open
// redirect / phishing). safeRedirectTarget rejects that case (plus the `/\`
// backslash and control-char variants) and falls back to '/'.

import { describe, it, expect } from 'vitest';
import { safeRedirectTarget } from './redirectTarget';

describe('safeRedirectTarget', () => {
  it('allows a same-origin path', () => {
    expect(safeRedirectTarget('/inbox')).toBe('/inbox');
  });

  it('still allows a normal nested same-origin path', () => {
    expect(safeRedirectTarget('/admin/quotes/123')).toBe('/admin/quotes/123');
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

  // Backslash forms normalize to a protocol-relative HOST under the WHATWG URL
  // parser, so they open-redirect exactly like `//host`.
  it('rejects the /\\host backslash form, falling back to /', () => {
    expect(safeRedirectTarget('/\\evil.com/x')).toBe('/');
  });

  it('rejects the /\\/host backslash form, falling back to /', () => {
    expect(safeRedirectTarget('/\\/evil.com')).toBe('/');
  });

  // ASCII tab/newline/CR are stripped by the URL parser before parsing, so a
  // leading `/<control>/host` re-forms as `//host` and navigates off-origin.
  it('rejects a control-char (tab/newline/CR) at position 1 that re-forms //host', () => {
    expect(safeRedirectTarget('/\t/evil.com')).toBe('/'); // was ?from=/%09/evil.com
    expect(safeRedirectTarget('/\n/evil.com')).toBe('/');
    expect(safeRedirectTarget('/\r/evil.com')).toBe('/');
  });

  it('rejects any embedded tab/newline/CR even mid-path', () => {
    expect(safeRedirectTarget('/inbox\t//evil.com')).toBe('/');
  });
});
