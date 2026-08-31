// The login page carries the QUOTE app's manifest and icon by inheritance, and
// iOS reads the manifest of whatever page is on screen when you tap Add to Home
// Screen. Anyone heading for the advertising app while signed out lands here
// first, so without this the ads icon they installed was the quote one.
//
// These pin the choice itself. The mutation to watch for is someone loosening
// the match to a bare `startsWith('/advertising')`, which would also swallow a
// hypothetical `/advertisingsomethingelse`.

import { describe, it, expect } from 'vitest';
import { generateMetadata } from './page';

const call = (from?: string | string[]) =>
  generateMetadata({ searchParams: Promise.resolve(from === undefined ? {} : { from }) });

describe('login page metadata', () => {
  it('inherits the quote identity when there is no ?from=', async () => {
    expect(await call()).toEqual({});
  });

  it('inherits the quote identity for an ordinary operator destination', async () => {
    for (const from of ['/', '/inbox', '/admin/quotes/123', '/settings']) {
      expect(await call(from), from).toEqual({});
    }
  });

  it('serves the advertising identity for every advertising door', async () => {
    for (const from of [
      '/advertising',
      '/advertising/',
      '/advertising/go',
      '/advertising/capture',
      '/admin/advertising',
      '/admin/advertising/capture',
    ]) {
      const meta = await call(from);
      expect(meta.manifest, from).toBe('/manifest-advertising.webmanifest');
      expect(meta.applicationName, from).toBe('YLL Advertising');
    }
  });

  it('names YLL Ads on the home screen, not the quote tool', async () => {
    const meta = await call('/advertising/go');
    expect(meta.appleWebApp).toMatchObject({ title: 'YLL Ads', capable: true });
    expect(JSON.stringify(meta.icons)).toContain('/icons/yll-advertising-apple-touch.png');
  });

  it('does not match a path that merely starts with the same letters', async () => {
    expect(await call('/advertisingsomethingelse')).toEqual({});
    expect(await call('/admin/advertisingsomethingelse')).toEqual({});
  });

  it('ignores a repeated ?from= rather than guessing which one to trust', async () => {
    expect(await call(['/advertising/go', '/inbox'])).toEqual({});
  });
});
