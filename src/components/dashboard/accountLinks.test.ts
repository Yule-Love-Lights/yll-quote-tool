// The account menu's link list (Naldo, 2026-08-31). These rows are the ONLY
// doors to the pages they name, so the list itself is worth pinning: a typo
// here is a page nobody can reach, not a link that merely looks broken.

import { readdirSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { ACCOUNT_LINKS, accountLinksFor } from './accountLinks';

describe('ACCOUNT_LINKS', () => {
  it('carries the rows Naldo asked for, in order', () => {
    expect(ACCOUNT_LINKS.map((l) => l.label)).toEqual([
      'Settings',
      'Insights',
      'Call recordings',
      'Website leads',
      'Who can see what',
      'Time tracking',
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

  it('marks the website-leads row admin-only, because its API is requireAdmin', () => {
    // /api/admin/leads answers a signed-in non-admin with 403, and the page
    // only redirects on 401, so that 403 lands as a red error banner. A dead
    // end either way, so the row is not offered to an operator.
    const leads = ACCOUNT_LINKS.find((l) => l.href === '/admin/leads');
    expect(leads?.adminOnly).toBe(true);
  });

  // Premerge staff lens: staff say "leads" all day about the Inbox, whose
  // badge reads "N leads waiting in the inbox". This page is the website-form
  // sync, and its own heading says Website leads.
  it('does not label the website-form page with the Inbox’s word for its own queue', () => {
    const leads = ACCOUNT_LINKS.find((l) => l.href === '/admin/leads');
    expect(leads?.label).toBe('Website leads');
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
  it('gives a CONFIRMED admin every row', () => {
    expect(accountLinksFor('admin', true).map((l) => l.label)).toEqual([
      'Settings',
      'Insights',
      'Call recordings',
      'Website leads',
      'Who can see what',
      'Time tracking',
    ]);
  });

  it('hides the admin-only rows from a plain operator', () => {
    const labels = accountLinksFor('operator', true).map((l) => l.label);
    expect(labels).toEqual(['Settings', 'Insights', 'Call recordings']);
    expect(labels).not.toContain('Website leads');
    expect(labels).not.toContain('Who can see what');
    expect(labels).not.toContain('Time tracking');
  });

  it('marks the time-tracking row admin-only, because the page redirects a non-admin', () => {
    // /admin/time-tracking calls getSessionRole() and redirect('/')s anyone
    // who is not an admin, so offering the row to an operator is a dead end.
    expect(ACCOUNT_LINKS.find((l) => l.href === '/admin/time-tracking')?.adminOnly).toBe(true);
  });

  it('treats an unresolved role as not-admin, the same safe default as View-as', () => {
    expect(accountLinksFor(null, true).map((l) => l.label)).not.toContain('Website leads');
    expect(accountLinksFor(null, false).map((l) => l.label)).not.toContain('Website leads');
  });

  // Premerge admin lens: OperatorNav seeds the role from a localStorage hint
  // one tick after hydration so an admin's controls appear at first paint. On
  // a shared office computer that hint can still say 'admin' for the NEXT
  // person, so an admin-only row must wait for the session answer.
  it('withholds an admin-only row while the role is only a HINT', () => {
    const labels = accountLinksFor('admin', false).map((l) => l.label);
    expect(labels).not.toContain('Website leads');
    expect(labels).toEqual(['Settings', 'Insights', 'Call recordings']);
  });

  it('never hides a row that is open to everyone, confirmed or not', () => {
    for (const role of ['admin', 'operator', null] as const) {
      for (const confirmed of [true, false]) {
        const labels = accountLinksFor(role, confirmed).map((l) => l.label);
        expect(labels).toContain('Settings');
        expect(labels).toContain('Insights');
        expect(labels).toContain('Call recordings');
      }
    }
  });
});
