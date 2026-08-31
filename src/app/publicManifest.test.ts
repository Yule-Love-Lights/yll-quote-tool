// The root layout advertises the OPERATOR app: src/app/layout.tsx sets
// manifest: '/manifest-quote.webmanifest', whose start_url is '/', which for
// anyone who is not office staff is our login screen. Next inherits that field
// down the whole segment tree, so EVERY page gets it unless the page or one of
// its layouts sets manifest: null.
//
// That is fine for operator surfaces and wrong for every public one: a visitor
// who adds a public page to their home screen would get an icon that opens our
// login instead of their content.
//
// This guard exists because the session that introduced the manifest fixed the
// gap for /portal and /refer and missed /estimate, /referral-link, /forms and
// /crew. All four wrap-review lenses found the same hole independently, which is
// what a class of defect looks like rather than a one-off miss. A test is the
// only thing that makes the next public page inherit the lesson: adding one
// without an override fails here instead of shipping a broken icon.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const APP_DIR = join(__dirname);

/**
 * Public page routes, and the file that is expected to carry the override.
 * A route is listed here when operatorGate.isPublicPath() serves its PAGE to a
 * signed-out visitor. API routes are irrelevant: they emit no HTML head.
 */
const PUBLIC_PAGE_SURFACES: { route: string; file: string }[] = [
  { route: '/portal/**', file: 'portal/layout.tsx' },
  { route: '/refer/**', file: 'refer/layout.tsx' },
  { route: '/estimate', file: 'estimate/page.tsx' },
  { route: '/referral-link', file: 'referral-link/page.tsx' },
  { route: '/forms/<type>', file: 'forms/[type]/page.tsx' },
  { route: '/crew/**', file: 'crew/layout.tsx' },
];

describe('public pages do not advertise the operator app', () => {
  it.each(PUBLIC_PAGE_SURFACES)(
    '$route drops the inherited manifest in $file',
    ({ file }) => {
      const path = join(APP_DIR, file);
      expect(existsSync(path), `${file} is missing — did the route move?`).toBe(true);
      // Deliberately a source assertion rather than an import: several of these
      // modules pull server-only dependencies, and what actually has to be true
      // is that the declaration is present in the file Next reads.
      expect(readFileSync(path, 'utf8')).toContain('manifest: null');
    },
  );

  it('the login page is NOT on that list, because it varies its manifest instead', () => {
    // /login is public and deliberately keeps a manifest: it serves the
    // advertising identity when ?from= points into the advertising surface, so
    // a crew member installing from the login screen saves the right app. Pinned
    // here so nobody "fixes" it by nulling it to match the others.
    const login = readFileSync(join(APP_DIR, 'login/page.tsx'), 'utf8');
    expect(login).toContain("manifest: '/manifest-advertising.webmanifest'");
    expect(login).not.toContain('manifest: null');
  });

  it('the root layout still sets the operator manifest it is meant to set', () => {
    // The whole reason the overrides above are needed. If this ever stops being
    // true, the overrides are dead weight and this file should be revisited
    // rather than left asserting something that no longer matters.
    const root = readFileSync(join(APP_DIR, 'layout.tsx'), 'utf8');
    expect(root).toContain('manifest: "/manifest-quote.webmanifest"');
  });
});
