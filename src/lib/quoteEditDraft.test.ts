import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  saveQuoteEditDraft,
  loadQuoteEditDraft,
  clearQuoteEditDraft,
  sweepQuoteEditDrafts,
  formatDraftAge,
} from './quoteEditDraft';
import type { QuoteFormData } from './quoteForm';
import { initialFormData } from './quoteForm';

// Row 413 — the edit-mode draft is only safe because of its base check: a
// draft is offered back ONLY when the server row still serializes to the
// exact snapshot the draft was edited on top of. That check is what lets
// edit-mode have an autosave at all without waiving the reopen-safety rule
// that keeps the old new-quote draft gated off for reopened quotes.

const QUOTE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const QUOTE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BASE = '{"front":95}';
const form = (): QuoteFormData => ({ ...initialFormData });

function stubLocalStorage() {
  const store = new Map<string, string>();
  const ls = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal('window', { localStorage: ls } as never);
  return store;
}

beforeEach(() => {
  stubLocalStorage();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('quoteEditDraft (row 413)', () => {
  it('round-trips a draft when the server base has not moved', () => {
    saveQuoteEditDraft(QUOTE_A, form(), BASE);
    const got = loadQuoteEditDraft(QUOTE_A, BASE);
    expect(got).not.toBeNull();
    expect(got!.base).toBe(BASE);
    expect(got!.form).toEqual(form());
  });

  it('REFUSES and clears the draft when the server row moved — the clobber guard', () => {
    // This is the whole reason edit-mode may have an autosave: another
    // operator (or another tab) saved since the stash, so restoring the
    // draft would overwrite their work. The server wins, silently.
    const store = stubLocalStorage();
    saveQuoteEditDraft(QUOTE_A, form(), BASE);
    const got = loadQuoteEditDraft(QUOTE_A, '{"front":100}');
    expect(got).toBeNull();
    expect(store.size).toBe(0); // cleared, not just hidden
  });

  it('drafts are per-quote: quote B cannot see quote A\'s stash', () => {
    saveQuoteEditDraft(QUOTE_A, form(), BASE);
    expect(loadQuoteEditDraft(QUOTE_B, BASE)).toBeNull();
    expect(loadQuoteEditDraft(QUOTE_A, BASE)).not.toBeNull();
  });

  it('expires a stale draft on load (7-day TTL, same as the new-quote draft)', () => {
    vi.useFakeTimers();
    try {
      saveQuoteEditDraft(QUOTE_A, form(), BASE);
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      expect(loadQuoteEditDraft(QUOTE_A, BASE)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sweep drops expired and unparseable stashes without touching live ones', () => {
    vi.useFakeTimers();
    try {
      const store = stubLocalStorage();
      saveQuoteEditDraft(QUOTE_A, form(), BASE);
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      saveQuoteEditDraft(QUOTE_B, form(), BASE); // fresh, must survive
      store.set('yll_quote_edit_draft_v1:garbage', 'not json');
      store.set('unrelated_key', 'untouched');
      sweepQuoteEditDrafts();
      expect(loadQuoteEditDraft(QUOTE_A, BASE)).toBeNull();
      expect(loadQuoteEditDraft(QUOTE_B, BASE)).not.toBeNull();
      expect(store.has('yll_quote_edit_draft_v1:garbage')).toBe(false);
      expect(store.get('unrelated_key')).toBe('untouched');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear removes exactly its own quote\'s stash', () => {
    saveQuoteEditDraft(QUOTE_A, form(), BASE);
    saveQuoteEditDraft(QUOTE_B, form(), BASE);
    clearQuoteEditDraft(QUOTE_A);
    expect(loadQuoteEditDraft(QUOTE_A, BASE)).toBeNull();
    expect(loadQuoteEditDraft(QUOTE_B, BASE)).not.toBeNull();
  });

  it('survives a missing window (SSR) without throwing', () => {
    vi.unstubAllGlobals();
    expect(() => saveQuoteEditDraft(QUOTE_A, form(), BASE)).not.toThrow();
    expect(loadQuoteEditDraft(QUOTE_A, BASE)).toBeNull();
    expect(() => sweepQuoteEditDrafts()).not.toThrow();
  });
});

describe('formatDraftAge (row 413)', () => {
  const now = 1_700_000_000_000;
  it('reads plainly at every scale', () => {
    expect(formatDraftAge(now - 30_000, now)).toBe('moments ago');
    expect(formatDraftAge(now - 5 * 60_000, now)).toBe('5 minutes ago');
    expect(formatDraftAge(now - 60_000, now)).toBe('1 minute ago');
    expect(formatDraftAge(now - 3 * 3_600_000, now)).toBe('3 hours ago');
    expect(formatDraftAge(now - 24 * 3_600_000, now)).toBe('yesterday');
    expect(formatDraftAge(now - 3 * 24 * 3_600_000, now)).toBe('3 days ago');
  });
});
