// The role HINT (ops suggestions round, 2026-08-29): a display-only
// localStorage echo of the last session answer, so the admin View-as strip
// renders one effect tick after hydration instead of waiting a full
// GET /api/auth/session round trip on every page. The session fetch stays
// the truth and overwrites the hint; a spoofed or stale hint can only show
// a strip whose destinations are server-gated anyway.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { readRoleHint, writeRoleHint, ROLE_HINT_KEY } from './roleHint';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('roleHint', () => {
  it('round-trips the two real roles', () => {
    writeRoleHint('admin');
    expect(readRoleHint()).toBe('admin');
    writeRoleHint('operator');
    expect(readRoleHint()).toBe('operator');
  });

  it('null clears the hint (signed out leaves nothing behind)', () => {
    writeRoleHint('admin');
    writeRoleHint(null);
    expect(readRoleHint()).toBeNull();
    expect(store.has(ROLE_HINT_KEY)).toBe(false);
  });

  it('returns null for garbage a user typed into devtools', () => {
    store.set(ROLE_HINT_KEY, 'superadmin');
    expect(readRoleHint()).toBeNull();
  });

  it('returns null when there is no stored value', () => {
    expect(readRoleHint()).toBeNull();
  });

  it('never throws when localStorage itself throws (private mode, blocked storage)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readRoleHint()).toBeNull();
    expect(() => writeRoleHint('admin')).not.toThrow();
  });

  it('returns null when localStorage does not exist at all (SSR)', () => {
    vi.unstubAllGlobals();
    expect(readRoleHint()).toBeNull();
    expect(() => writeRoleHint('admin')).not.toThrow();
  });
});
