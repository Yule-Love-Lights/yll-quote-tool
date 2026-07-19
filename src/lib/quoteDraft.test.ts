// Tests for the QuoteBuilder localStorage draft helper (quote-forms-partial-save).
// It's a browser-only module (no-ops unless window.localStorage exists), so these
// install a Map-backed fake window + control Date.now for the TTL.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  loadQuoteDraft,
  saveQuoteDraft,
  clearQuoteDraft,
  customerIsEmpty,
  draftAutosaveActive,
} from './quoteDraft';

const KEY = 'yll_quote_draft_v1';
const EMPTY = { name: '', phone: '', email: '', address: '' };
const CUST = { name: 'Jane Smith', phone: '5551234567', email: 'jane@example.com', address: '1 Main St' };

let store: Map<string, string>;

function installFakeWindow(): Map<string, string> {
  const s = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => (s.has(k) ? s.get(k)! : null),
    setItem: (k: string, v: string) => void s.set(k, v),
    removeItem: (k: string) => void s.delete(k),
  };
  (globalThis as unknown as { window?: unknown }).window = { localStorage };
  return s;
}

beforeEach(() => {
  store = installFakeWindow();
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.restoreAllMocks();
});

describe('quoteDraft', () => {
  it('round-trips a saved customer draft', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    saveQuoteDraft(CUST, 'permanent');
    const d = loadQuoteDraft();
    expect(d?.customer).toEqual(CUST);
    expect(d?.serviceType).toBe('permanent');
  });

  it('never persists an all-empty customer block (clears instead)', () => {
    saveQuoteDraft(CUST, 'holiday');
    saveQuoteDraft(EMPTY, 'holiday');
    expect(loadQuoteDraft()).toBeNull();
    expect(store.has(KEY)).toBe(false);
  });

  it('clearQuoteDraft removes the draft', () => {
    saveQuoteDraft(CUST, 'holiday');
    clearQuoteDraft();
    expect(loadQuoteDraft()).toBeNull();
  });

  it('drops AND clears a draft older than the 7-day TTL', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const t0 = 10_000_000_000;
    nowSpy.mockReturnValue(t0);
    saveQuoteDraft(CUST, 'holiday');
    nowSpy.mockReturnValue(t0 + 8 * 24 * 60 * 60 * 1000); // 8 days later
    expect(loadQuoteDraft()).toBeNull();
    expect(store.has(KEY)).toBe(false); // stale PII wiped, not just hidden
  });

  it('keeps a draft still within the TTL', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    const t0 = 10_000_000_000;
    nowSpy.mockReturnValue(t0);
    saveQuoteDraft(CUST, 'holiday');
    nowSpy.mockReturnValue(t0 + 2 * 24 * 60 * 60 * 1000); // 2 days later
    expect(loadQuoteDraft()?.customer.name).toBe('Jane Smith');
  });

  it('returns null on malformed JSON without throwing', () => {
    store.set(KEY, '{not json');
    expect(loadQuoteDraft()).toBeNull();
  });

  it('customerIsEmpty detects blank vs filled', () => {
    expect(customerIsEmpty(EMPTY)).toBe(true);
    expect(customerIsEmpty({ ...EMPTY, email: 'x@y.z' })).toBe(false);
  });
});

describe('draftAutosaveActive (reopen-safety gate)', () => {
  it('is active ONLY for a new, non-test, unsaved quote', () => {
    expect(draftAutosaveActive({ editMode: false, isTest: false, savedQuoteId: null })).toBe(true);
  });

  it('is inactive for a reopened/edit quote, a test quote, or one already saved', () => {
    expect(draftAutosaveActive({ editMode: true, isTest: false, savedQuoteId: null })).toBe(false);
    expect(draftAutosaveActive({ editMode: false, isTest: true, savedQuoteId: null })).toBe(false);
    expect(draftAutosaveActive({ editMode: false, isTest: false, savedQuoteId: 'q-1' })).toBe(false);
  });
});
