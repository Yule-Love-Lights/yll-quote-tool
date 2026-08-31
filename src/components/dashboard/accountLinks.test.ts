// The account menu's link list (Naldo, 2026-08-31). These rows are the ONLY
// doors to the pages they name, so the list itself is worth pinning: a typo
// here is a page nobody can reach, not a link that merely looks broken.

import { readdirSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { ACCOUNT_LINKS, accountLinksFor } from './accountLinks';

describe('ACCOUNT_LINKS', () => {
  it('carries the four rows Naldo asked for, in order', () => {
    expect(ACCOUNT_LINKS.map((l) => l.label)).toEqual([
      'Settings',
      'Insights',
      'Call recordings',
      'Leads',
    ]);
  });

  it('points every row at a route that actually exists', () => {
    // The real defence against a typo. A route directory must exist and hold
    // a page file, or the row opens a 404 and the page becomes unreachable,
    // since these rows replaced the nav tabs entirely.
    const root = new URL('../../app/', import.meta.url);
    for (const link of ACCOUNT_LINKS) {
      const dir = new URL(`.${link.href}/`, root);
      expect(existsSync(dir), `${link.href} has no route directory`).toBe(true);
      const files = readdirSync(dir);
      expect(
        files.some((f) => /^page\.(tsx|ts|jsx|js)$/.test(f)),
        `${link.href} has no page file`,
      ).toBe(true);
    }
  });

  it('has no duplicate hrefs or labels', () => {
    expect(new Set(ACCOUNT_LINKS.map((l) => l.href)).size).toBe(ACCOUNT_LINKS.length);
    expect(new Set(ACCOUNT_LINKS.map((l) => l.label)).size).toBe(ACCOUNT_LINKS.length);
  });

  it('marks Leads admin-only, because its API is requireAdmin', () => {
    // The page fetches /api/admin/leads, which is requireAdmin, and bounces to
    // /login on the 401 rather than explaining itself. An ungated row would
    // send a plain operator to a sign-in screen they are already signed in
    // past.
    const leads = ACCOUNT_LINKS.find((l) => l.href === '/admin/leads');
    expect(leads?.adminOnly).toBe(true);
  });

  it('leaves the operator-gated rows open to everyone', () => {
    for (const href of ['/settings', '/insights', '/admin/calls']) {
      expect(ACCOUNT_LINKS.find((l) => l.href === href)?.adminOnly).toBeUndefined();
    }
  });

  it('uses absolute in-app paths, never an external or relative one', () => {
    for (const link of ACCOUNT_LINKS) {
      expect(link.href.startsWith('/')).toBe(true);
      expect(link.href).not.toContain('://');
    }
  });
});

describe('accountLinksFor', () => {
  it('gives an admin every row', () => {
    expect(accountLinksFor('admin').map((l) => l.label)).toEqual([
      'Settings',
      'Insights',
      'Call recordings',
      'Leads',
    ]);
  });

  it('hides the admin-only rows from a plain operator', () => {
    const labels = accountLinksFor('operator').map((l) => l.label);
    expect(labels).toEqual(['Settings', 'Insights', 'Call recordings']);
    expect(labels).not.toContain('Leads');
  });

  it('treats an unresolved role as not-admin, the same safe default as View-as', () => {
    expect(accountLinksFor(null).map((l) => l.label)).not.toContain('Leads');
  });

  it('never hides a row that is open to everyone', () => {
    for (const role of ['admin', 'operator', null] as const) {
      const labels = accountLinksFor(role).map((l) => l.label);
      expect(labels).toContain('Settings');
      expect(labels).toContain('Insights');
      expect(labels).toContain('Call recordings');
    }
  });
});
