// Proves the permissions page is telling the truth.
//
// The page reads a DECLARED table (rolePermissions.ts). A declared table that
// nothing checks is a document, and documents about permissions go stale
// silently and then get believed. Every claim in that table is verified here
// against the actual source: the pages must exist, the API routes must carry
// the gate claimed for them, and the perimeter must agree about which surface
// each role sits on.
//
// If this file fails, the page is lying. Fix the table or fix the route.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { ROLES, roleById, type Capability, type RoleId } from './rolePermissions';
import { isAdvertisingPath, isPublicPath } from './operatorGate';

const APP_ROOT = new URL('../../app/', import.meta.url);

/** Every capability in the table, tagged with the role that claims it. */
const ALL: { role: RoleId; cap: Capability }[] = ROLES.flatMap((r) =>
  r.can.map((cap) => ({ role: r.id, cap })),
);

/** Route segments are directories; [id] is a real directory name on disk. */
function dirFor(routePath: string): URL {
  return new URL(`.${routePath}/`, APP_ROOT);
}

function hasFile(dir: URL, pattern: RegExp): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => pattern.test(f));
}

function routeSource(apiPath: string): string {
  const dir = dirFor(apiPath);
  return readFileSync(new URL('route.ts', dir), 'utf8');
}

describe('the pages every role is told it can open', () => {
  it('all exist', () => {
    for (const { role, cap } of ALL) {
      if (!cap.page) continue;
      const dir = dirFor(cap.page);
      expect(existsSync(dir), `${role}: ${cap.page} has no route directory`).toBe(true);
      expect(
        hasFile(dir, /^page\.(tsx|ts|jsx|js)$/),
        `${role}: ${cap.page} has no page file`,
      ).toBe(true);
    }
  });
});

describe('the API routes every role is told it can use', () => {
  it('all exist', () => {
    for (const { role, cap } of ALL) {
      if (!cap.api) continue;
      expect(
        hasFile(dirFor(cap.api), /^route\.ts$/),
        `${role}: ${cap.api} has no route file`,
      ).toBe(true);
    }
  });

  it('carry exactly the gate the table claims', () => {
    for (const { role, cap } of ALL) {
      if (!cap.api || !cap.gate) continue;
      const src = routeSource(cap.api);
      if (cap.gate === 'admin') {
        expect(src, `${role}: ${cap.api} is claimed admin-only`).toContain('requireAdmin');
      }
      if (cap.gate === 'operator') {
        expect(src, `${role}: ${cap.api} is claimed operator-level`).toContain('requireOperator');
        // The distinction that matters: an operator-level claim must NOT be
        // sitting on an admin-gated route, or the table promises office staff
        // something they cannot actually open.
        expect(src, `${role}: ${cap.api} is claimed operator-level but requires admin`).not.toContain(
          'requireAdmin',
        );
      }
      if (cap.gate === 'advertising') {
        expect(src, `${role}: ${cap.api} is claimed advertising-only`).toContain(
          'getAdvertisingCaller',
        );
      }
      if (cap.gate === 'crew-link') {
        // Two spellings of the same mechanism: the page resolves the cookie
        // directly, the route wraps it. Both read the signed-link session and
        // neither accepts an operator login, which is the claim being made.
        const crewGated = src.includes('withCrewSession') || src.includes('resolveCrewCaller');
        expect(crewGated, `${role}: ${cap.api} is claimed crew-link gated`).toBe(true);
        // And it must NOT be reachable with an ordinary operator session.
        expect(src, `${role}: ${cap.api} must not take an operator session`).not.toContain(
          'requireOperator',
        );
      }
    }
  });
});

describe('the perimeter agrees with the table', () => {
  it('puts every advertising capability inside the advertising fence', () => {
    const ad = roleById('advertising');
    expect(ad).toBeDefined();
    for (const cap of ad!.can) {
      for (const path of [cap.page, cap.api].filter((p): p is string => !!p)) {
        expect(isAdvertisingPath(path), `${path} is claimed for advertising but sits outside the fence`).toBe(
          true,
        );
      }
    }
  });

  it('keeps every office and admin capability OUTSIDE that fence', () => {
    // The fence is what stops an advertising account reaching customer data.
    // An office path that fell inside it would be reachable by them.
    for (const { role, cap } of ALL) {
      if (role !== 'office' && role !== 'admin') continue;
      for (const path of [cap.page, cap.api].filter((p): p is string => !!p)) {
        expect(isAdvertisingPath(path), `${role}: ${path} sits inside the advertising fence`).toBe(
          false,
        );
      }
    }
  });

  it('treats the crew door as public, because a link is not a login', () => {
    // /crew carries no operator session. It is allowlisted at the perimeter and
    // gated by the signed-link cookie instead, which is exactly the thing the
    // page exists to explain.
    const crew = roleById('crew');
    for (const cap of crew!.can) {
      for (const path of [cap.page, cap.api].filter((p): p is string => !!p)) {
        expect(isPublicPath(path), `${path} is a crew path and must be allowlisted`).toBe(true);
      }
    }
  });

  it('does NOT allowlist the office surface', () => {
    for (const { role, cap } of ALL) {
      if (role !== 'office' && role !== 'admin') continue;
      for (const path of [cap.page, cap.api].filter((p): p is string => !!p)) {
        expect(isPublicPath(path), `${role}: ${path} is publicly reachable`).toBe(false);
      }
    }
  });

  it('still blocks crew ACCOUNTS outright, which is what the table says', () => {
    // The table tells Jason a crew account is refused at the perimeter. If that
    // ever stops being true, this catches it.
    const proxy = readFileSync(new URL('../../proxy.ts', import.meta.url), 'utf8');
    expect(proxy).toContain('isCrewAccount');
    expect(proxy).toContain('Forbidden');
  });
});

describe('the page that renders this table', () => {
  const PAGE = readFileSync(
    new URL('../../app/admin/permissions/page.tsx', import.meta.url),
    'utf8',
  );

  it('refuses a non-admin server-side, not just by hiding the menu row', () => {
    // The menu row is cosmetic. This redirect is the actual refusal, and
    // without this assertion removing it breaks nothing that anyone notices.
    expect(PAGE).toContain('getSessionRole');
    expect(PAGE).toContain("if (role !== 'admin') redirect('/')");
  });

  it('renders the shared table rather than a second copy of the list', () => {
    // A page with its own hand-written list would drift from the verified one
    // and this whole file would be checking something nobody reads.
    expect(PAGE).toContain("from '@/lib/auth/rolePermissions'");
    expect(PAGE).toContain('ROLES.map');
  });
});

describe('the table itself', () => {
  it('covers all four populations, office first', () => {
    expect(ROLES.map((r) => r.id)).toEqual(['office', 'admin', 'advertising', 'crew']);
  });

  it('says what each role CANNOT do, which is half the question', () => {
    for (const r of ROLES) {
      expect(r.cannot.length, `${r.id} lists nothing it cannot do`).toBeGreaterThan(0);
      expect(r.can.length, `${r.id} lists nothing it can do`).toBeGreaterThan(0);
    }
  });

  it('explains how each population signs in, since three mechanisms are in play', () => {
    for (const r of ROLES) {
      expect(r.howTheySignIn.length, `${r.id} does not say how they sign in`).toBeGreaterThan(20);
      expect(r.whoTheyAre.length, `${r.id} does not say who they are`).toBeGreaterThan(20);
    }
  });

  it('is explicit that crew do not have a login', () => {
    // The single most misleading thing about this system if you read the code:
    // the crew ROLE exists and means "refuse", not "allow".
    const crew = roleById('crew')!;
    expect(crew.howTheySignIn.toLowerCase()).toContain('do not');
    expect(crew.cannot.join(' ').toLowerCase()).toContain('no crew login form');
  });
});
