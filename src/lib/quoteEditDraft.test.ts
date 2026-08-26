import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  saveQuoteEditDraft,
  loadQuoteEditDraft,
  clearQuoteEditDraft,
  sweepQuoteEditDrafts,
  formatDraftAge,
  quoteEditDraftLifecycle,
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
const LIFE = '{"status":null,"approvedAt":null,"depositPaidAt":null}';
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
    saveQuoteEditDraft(QUOTE_A, form(), BASE, LIFE);
    const got = loadQuoteEditDraft(QUOTE_A, BASE, LIFE);
    expect(got).not.toBeNull();
    expect(got).not.toBe('server-moved');
    const draft = got as Exclude<typeof got, 'server-moved' | 'lifecycle-moved' | null>;
    expect(draft.base).toBe(BASE);
    expect(draft.form).toEqual(form());
  });

  it('REFUSES and clears the draft when the server row moved — the clobber guard', () => {
    // This is the whole reason edit-mode may have an autosave: another
    // operator (or another tab) saved since the stash, so restoring the
    // draft would overwrite their work. The server wins, silently.
    const store = stubLocalStorage();
    saveQuoteEditDraft(QUOTE_A, form(), BASE, LIFE);
    const got = loadQuoteEditDraft(QUOTE_A, '{"front":100}', LIFE);
    // PR #972 staff lens MED: the drop is no longer silent - the caller gets
    // 'server-moved' to show an informational notice. The draft is still
    // cleared either way; nothing is restorable.
    expect(got).toBe('server-moved');
    expect(store.size).toBe(0); // cleared, not just hidden
  });

  it('drafts are per-quote: quote B cannot see quote A\'s stash', () => {
    saveQuoteEditDraft(QUOTE_A, form(), BASE, LIFE);
    expect(loadQuoteEditDraft(QUOTE_B, BASE, LIFE)).toBeNull();
    expect(loadQuoteEditDraft(QUOTE_A, BASE, LIFE)).not.toBeNull();
  });

  it('expires a stale draft on load (7-day TTL, same as the new-quote draft)', () => {
    vi.useFakeTimers();
    try {
      saveQuoteEditDraft(QUOTE_A, form(), BASE, LIFE);
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      expect(loadQuoteEditDraft(QUOTE_A, BASE, LIFE)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('sweep drops expired and unparseable stashes without touching live ones', () => {
    vi.useFakeTimers();
    try {
      const store = stubLocalStorage();
      saveQuoteEditDraft(QUOTE_A, form(), BASE, LIFE);
      vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
      saveQuoteEditDraft(QUOTE_B, form(), BASE, LIFE); // fresh, must survive
      store.set('yll_quote_edit_draft_v1:garbage', 'not json');
      store.set('unrelated_key', 'untouched');
      sweepQuoteEditDrafts();
      expect(loadQuoteEditDraft(QUOTE_A, BASE, LIFE)).toBeNull();
      expect(loadQuoteEditDraft(QUOTE_B, BASE, LIFE)).not.toBeNull();
      expect(store.has('yll_quote_edit_draft_v1:garbage')).toBe(false);
      expect(store.get('unrelated_key')).toBe('untouched');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clear removes exactly its own quote\'s stash', () => {
    saveQuoteEditDraft(QUOTE_A, form(), BASE, LIFE);
    saveQuoteEditDraft(QUOTE_B, form(), BASE, LIFE);
    clearQuoteEditDraft(QUOTE_A);
    expect(loadQuoteEditDraft(QUOTE_A, BASE, LIFE)).toBeNull();
    expect(loadQuoteEditDraft(QUOTE_B, BASE, LIFE)).not.toBeNull();
  });

  // ─── Row 420: the lifecycle CAS ─────────────────────────────────────────
  // The base check above binds a draft to the FORM it was edited on top of.
  // /approve and the deposit webhook never touch inputs/result, so base still
  // matches after the customer approved or booked — the lifecycle stamp is
  // what refuses a pre-approval draft on a now-booked order.

  it('row 420: REFUSES and clears the draft when the lifecycle moved, even though base matches', () => {
    const store = stubLocalStorage();
    saveQuoteEditDraft(QUOTE_A, form(), BASE, LIFE);
    const booked = quoteEditDraftLifecycle({
      status: null,
      approvedAt: '2026-08-20T00:00:00Z',
      depositPaidAt: '2026-08-21T00:00:00Z',
    });
    const got = loadQuoteEditDraft(QUOTE_A, BASE, booked);
    expect(got).toBe('lifecycle-moved');
    expect(store.size).toBe(0); // cleared, not just hidden
  });

  it('row 420: still offered when the lifecycle is unchanged', () => {
    const stamped = quoteEditDraftLifecycle({ status: 'sent', approvedAt: null, depositPaidAt: null });
    saveQuoteEditDraft(QUOTE_A, form(), BASE, stamped);
    const got = loadQuoteEditDraft(QUOTE_A, BASE, stamped);
    expect(got).not.toBeNull();
    expect(got).not.toBe('server-moved');
    expect(got).not.toBe('lifecycle-moved');
  });

  it('row 420 fix round: a legacy draft with NO lifecycle stamp is discarded WITH the notice (unverifiable = unsafe, but never silent)', () => {
    const store = stubLocalStorage();
    // Hand-write a pre-420 stash: form + base + savedAt, no lifecycle field.
    store.set(
      'yll_quote_edit_draft_v1:' + QUOTE_A,
      JSON.stringify({ form: form(), base: BASE, savedAt: Date.now() }),
    );
    expect(loadQuoteEditDraft(QUOTE_A, BASE, LIFE)).toBe('lifecycle-moved');
    expect(store.size).toBe(0);
  });

  // Row 420 fix round (premerge staff HIGH + customer MED): the raw status
  // column is written 'sent' by the operator's own Send click and 'viewed' by
  // the customer merely opening their portal link. Neither may kill a draft —
  // the stamp collapses the whole open pre-approval flow into one bucket.
  it('row 420 fix round: send and portal-view transitions do NOT discard the draft', () => {
    const atDraft = quoteEditDraftLifecycle({ status: 'draft', approvedAt: null, depositPaidAt: null });
    saveQuoteEditDraft(QUOTE_A, form(), BASE, atDraft);
    // Reopened after the quote was sent AND the homeowner peeked at it:
    const atViewed = quoteEditDraftLifecycle({ status: 'viewed', approvedAt: null, depositPaidAt: null });
    const got = loadQuoteEditDraft(QUOTE_A, BASE, atViewed);
    expect(got).not.toBe('lifecycle-moved');
    expect(got).not.toBe('server-moved');
    expect(got).not.toBeNull();
  });

  it('row 420 fix round: the open pre-approval statuses all stamp identically; real state moves stay distinct', () => {
    const open = ['draft', 'sent', 'viewed', null] as const;
    const stamps = open.map(s => quoteEditDraftLifecycle({ status: s, approvedAt: null, depositPaidAt: null }));
    expect(new Set(stamps).size).toBe(1);
    for (const s of ['approved', 'booked', 'declined', 'changes_requested', 'abandoned']) {
      expect(quoteEditDraftLifecycle({ status: s, approvedAt: null, depositPaidAt: null })).not.toBe(stamps[0]);
    }
  });

  it('row 420: quoteEditDraftLifecycle is exact — any one field moving changes the stamp', () => {
    const a = quoteEditDraftLifecycle({ status: 'sent', approvedAt: null, depositPaidAt: null });
    expect(quoteEditDraftLifecycle({ status: 'sent', approvedAt: null, depositPaidAt: null })).toBe(a);
    expect(quoteEditDraftLifecycle({ status: 'declined', approvedAt: null, depositPaidAt: null })).not.toBe(a);
    expect(quoteEditDraftLifecycle({ status: 'sent', approvedAt: '2026-08-20T00:00:00Z', depositPaidAt: null })).not.toBe(a);
    expect(quoteEditDraftLifecycle({ status: 'sent', approvedAt: null, depositPaidAt: '2026-08-21T00:00:00Z' })).not.toBe(a);
  });

  it('survives a missing window (SSR) without throwing', () => {
    vi.unstubAllGlobals();
    expect(() => saveQuoteEditDraft(QUOTE_A, form(), BASE, LIFE)).not.toThrow();
    expect(loadQuoteEditDraft(QUOTE_A, BASE, LIFE)).toBeNull();
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
