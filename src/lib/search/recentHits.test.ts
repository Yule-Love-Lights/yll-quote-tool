// The search box's "recently opened" list. Everything except the two storage
// calls is pure, which is where the rules that matter live.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  MAX_RECENT,
  clearRecent,
  isInAppPath,
  parseRecent,
  pushRecent,
  readRecent,
  toRecent,
  writeRecent,
  type RecentHit,
} from './recentHits';
import type { SearchHit } from './globalSearch';

const hit = (over: Partial<RecentHit>): RecentHit => ({
  kind: 'customer',
  key: 'customer:1',
  href: '/customers/1',
  title: 'Kristie Tibbetts',
  label: null,
  ...over,
});

describe('toRecent', () => {
  it('keeps identity and drops anything that goes stale', () => {
    const full: SearchHit = {
      kind: 'invoice',
      key: 'invoice:9',
      href: '/admin/invoices/9',
      title: 'Kristie Tibbetts',
      subtitle: '$500.00 due',
      label: '#1401',
      status: 'Awaiting payment',
      active: true,
      sortedAt: '2026-08-01T00:00:00Z',
    };
    // The status and the balance are the two things most likely to be wrong by
    // the time this row is looked at again, so they are deliberately not kept.
    expect(toRecent(full)).toEqual({
      kind: 'invoice',
      key: 'invoice:9',
      href: '/admin/invoices/9',
      title: 'Kristie Tibbetts',
      label: '#1401',
    });
  });
});

describe('pushRecent', () => {
  it('puts the newest first', () => {
    const out = pushRecent([hit({ key: 'a' })], hit({ key: 'b' }));
    expect(out.map((h) => h.key)).toEqual(['b', 'a']);
  });

  it('moves a record already in the list rather than duplicating it', () => {
    const out = pushRecent([hit({ key: 'a' }), hit({ key: 'b' })], hit({ key: 'b' }));
    expect(out.map((h) => h.key)).toEqual(['b', 'a']);
    expect(out).toHaveLength(2);
  });

  it('caps the list', () => {
    let list: RecentHit[] = [];
    for (let i = 0; i < MAX_RECENT + 4; i++) list = pushRecent(list, hit({ key: `k${i}` }));
    expect(list).toHaveLength(MAX_RECENT);
    // The oldest fell off, the newest is first.
    expect(list[0].key).toBe(`k${MAX_RECENT + 3}`);
    expect(list.some((h) => h.key === 'k0')).toBe(false);
  });

  it('does not mutate its input', () => {
    const input = [hit({ key: 'a' })];
    pushRecent(input, hit({ key: 'b' }));
    expect(input.map((h) => h.key)).toEqual(['a']);
  });
});

describe('parseRecent', () => {
  it('accepts a well-formed row', () => {
    expect(parseRecent([hit({})])).toHaveLength(1);
  });

  it('drops anything that is not a list', () => {
    expect(parseRecent(null)).toEqual([]);
    expect(parseRecent('nope')).toEqual([]);
    expect(parseRecent({ key: 'a' })).toEqual([]);
  });

  it('drops rows missing the fields a link needs', () => {
    expect(parseRecent([{ kind: 'customer', key: 'a' }])).toEqual([]);
    expect(parseRecent([{ ...hit({}), href: undefined }])).toEqual([]);
    expect(parseRecent([{ ...hit({}), kind: 'wat' }])).toEqual([]);
  });

  it('refuses a BACKSLASH authority, which the URL parser reads as protocol-relative', () => {
    // The first version of this guard blocked "//evil" with a prefix check and
    // let "/\evil" through, and the router follows it off-site just the same.
    // Found by the premerge technical lens, which traced it through the
    // installed router rather than reasoning about it. The check no longer
    // guesses at prefixes: it resolves against a throwaway origin and requires
    // the result to still be on it.
    const BACKSLASH = String.fromCharCode(92);
    const backslashAuthority = '/' + BACKSLASH + 'evil.example.com';
    expect(parseRecent([{ ...hit({}), href: backslashAuthority }])).toEqual([]);
    expect(isInAppPath(backslashAuthority)).toBe(false);
    expect(isInAppPath('/' + BACKSLASH + BACKSLASH + 'evil.example.com')).toBe(false);
  });

  it('refuses control characters, which the parser strips before deciding', () => {
    // Built from char codes on purpose: writing these as literals put REAL
    // control bytes into the file the first time, and one assertion then
    // silently tested a perfectly valid path.
    expect(isInAppPath('/' + String.fromCharCode(0) + 'evil')).toBe(false);
    expect(isInAppPath('/customers/1' + String.fromCharCode(31))).toBe(false);
  });

  it('still accepts ordinary in-app paths', () => {
    expect(isInAppPath('/customers/abc')).toBe(true);
    expect(isInAppPath('/admin/quotes/1?x=2#y')).toBe(true);
  });

  it('refuses an off-site href, which devtools could otherwise plant', () => {
    // This value is hand-editable. A stored absolute URL would turn a
    // "recently opened" row into a link off the app entirely.
    expect(parseRecent([{ ...hit({}), href: 'https://evil.example.com' }])).toEqual([]);
    expect(parseRecent([{ ...hit({}), href: '//evil.example.com' }])).toEqual([]);
    expect(parseRecent([{ ...hit({}), href: 'javascript:alert(1)' }])).toEqual([]);
  });

  it('never returns more than the cap, however much was stored', () => {
    const many = Array.from({ length: 50 }, (_, i) => hit({ key: `k${i}` }));
    expect(parseRecent(many)).toHaveLength(MAX_RECENT);
  });
});

describe('readRecent and writeRecent', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, v);
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips a list', () => {
    writeRecent([hit({ key: 'a' })]);
    expect(readRecent().map((h) => h.key)).toEqual(['a']);
  });

  it('uses SESSION storage, so the list dies with the tab on a shared computer', () => {
    // The office shares machines. These rows hold customer names, so they must
    // not greet the next person; the same session that added this REMOVED a
    // stored role for exactly that reason.
    writeRecent([hit({ key: 'a' })]);
    expect(store.size).toBe(1);
  });

  it('returns an empty list rather than throwing on unreadable storage', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(readRecent()).toEqual([]);
    expect(() => writeRecent([hit({})])).not.toThrow();
  });

  it('forgets everything on sign-out, for the tab left open across a shift change', () => {
    // sessionStorage survives a sign-out on a tab nobody closed, so without
    // this the next person to sign in on that tab is greeted by the last
    // person's customers (premerge staff lens).
    writeRecent([hit({ key: 'a' })]);
    expect(readRecent()).toHaveLength(1);
    clearRecent();
    expect(readRecent()).toEqual([]);
  });

  it('does not throw when clearing is refused', () => {
    vi.stubGlobal('sessionStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => clearRecent()).not.toThrow();
  });

  it('survives corrupted stored content', () => {
    store.set('yll-op-recent-hits', '{not json');
    expect(readRecent()).toEqual([]);
  });
});
