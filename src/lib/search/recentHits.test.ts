// The search box's "recently opened" list. Everything except the two storage
// calls is pure, which is where the rules that matter live.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  MAX_RECENT,
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

  it('survives corrupted stored content', () => {
    store.set('yll-op-recent-hits', '{not json');
    expect(readRecent()).toEqual([]);
  });
});
