// Tests for the #237 GHL "Event Date" custom-field push.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const hl = vi.hoisted(() => {
  class FakeHighLevelError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = 'HighLevelError';
      this.status = status;
    }
  }
  return {
    HighLevelError: FakeHighLevelError,
    configured: { value: true },
    listLocationCustomFields: vi.fn(async () => [] as Array<{ id: string; name: string }>),
    createLocationCustomField: vi.fn(async (_input: { name: string; dataType: string }) => ({
      id: 'created-field-1',
      name: 'Event Date',
    })),
    upsertContactCustomField: vi.fn(async (_contactId: string, _fieldId: string, _value: string | string[]) => {}),
  };
});

vi.mock('./highlevel', () => ({
  isHighLevelConfigured: () => hl.configured.value,
  HighLevelError: hl.HighLevelError,
  listLocationCustomFields: hl.listLocationCustomFields,
  createLocationCustomField: hl.createLocationCustomField,
  upsertContactCustomField: hl.upsertContactCustomField,
}));

import {
  formatEventDateForGhl,
  pushEventDateToGhl,
  resetEventDateFieldCacheForTests,
  EVENT_DATE_FIELD_NAME,
} from './ghlEventDate';

beforeEach(() => {
  vi.clearAllMocks();
  hl.configured.value = true;
  hl.listLocationCustomFields.mockResolvedValue([]);
  hl.createLocationCustomField.mockResolvedValue({ id: 'created-field-1', name: EVENT_DATE_FIELD_NAME });
  hl.upsertContactCustomField.mockResolvedValue(undefined);
  resetEventDateFieldCacheForTests();
});

describe('formatEventDateForGhl', () => {
  it('converts a well-formed ISO date to MM/DD/YYYY', () => {
    expect(formatEventDateForGhl('2026-12-25')).toBe('12/25/2026');
  });

  it('preserves leading zeros on both month and day', () => {
    expect(formatEventDateForGhl('2026-01-05')).toBe('01/05/2026');
  });

  it('null → empty string', () => {
    expect(formatEventDateForGhl(null)).toBe('');
  });

  it('undefined → empty string', () => {
    expect(formatEventDateForGhl(undefined)).toBe('');
  });

  it('empty string → empty string', () => {
    expect(formatEventDateForGhl('')).toBe('');
  });

  it('a blank/whitespace-only string → empty string', () => {
    expect(formatEventDateForGhl('   ')).toBe('');
  });

  it('a non-ISO shape (e.g. a full ISO timestamp) → empty string, not a best-effort parse', () => {
    expect(formatEventDateForGhl('2026-12-25T00:00:00.000Z')).toBe('');
  });

  it('a US-formatted string (MM/DD/YYYY) is rejected, not silently re-parsed', () => {
    expect(formatEventDateForGhl('12/25/2026')).toBe('');
  });

  it('an out-of-range month → empty string (defense-in-depth)', () => {
    expect(formatEventDateForGhl('2026-13-01')).toBe('');
  });

  it('an out-of-range day → empty string (defense-in-depth)', () => {
    expect(formatEventDateForGhl('2026-01-32')).toBe('');
  });

  // FIX C (#237 fix round, technical-lens MED): calendar-invalid dates that
  // still pass the old 01-31 bound.
  it('February 30 (no such day in ANY year) → empty string', () => {
    expect(formatEventDateForGhl('2026-02-30')).toBe('');
  });

  it('February 29 in a non-leap year (2026 is not a leap year) → empty string', () => {
    expect(formatEventDateForGhl('2026-02-29')).toBe('');
  });

  it('February 29 in a real leap year (2028) → passes through', () => {
    expect(formatEventDateForGhl('2028-02-29')).toBe('02/29/2028');
  });

  it('February 29 in a century non-leap year (2100, divisible by 100 but not 400) → empty string', () => {
    expect(formatEventDateForGhl('2100-02-29')).toBe('');
  });

  it('February 29 in a century leap year (2000, divisible by 400) → passes through', () => {
    expect(formatEventDateForGhl('2000-02-29')).toBe('02/29/2000');
  });

  it('April 31 (April has 30 days) → empty string', () => {
    expect(formatEventDateForGhl('2026-04-31')).toBe('');
  });

  it('a real April 30 → passes through', () => {
    expect(formatEventDateForGhl('2026-04-30')).toBe('04/30/2026');
  });

  // FIX E (#237 fix round): renamed from "never constructs a Date object
  // internally..." — the assertions below only ever compare two output
  // STRINGS and never spy on the global `Date` constructor, so this proves
  // the round-trip is correct, not that no Date was built (the file header's
  // own comment is what actually documents the no-Date-object design).
  it('a value that would shift under UTC-vs-local Date parsing round-trips exactly', () => {
    // 2026-01-01 is the classic "new Date('2026-01-01')" trap: parsed as UTC
    // midnight, some local timezones would print December 31 2025 instead.
    // Pure string splitting can't reproduce that bug.
    expect(formatEventDateForGhl('2026-01-01')).toBe('01/01/2026');
    expect(formatEventDateForGhl('2026-12-31')).toBe('12/31/2026');
  });
});

describe('pushEventDateToGhl — guards', () => {
  it('no contactId → skips entirely, touches nothing', async () => {
    const result = await pushEventDateToGhl(null, '2026-12-25');
    expect(result).toEqual({ pushed: false });
    expect(hl.listLocationCustomFields).not.toHaveBeenCalled();
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
  });

  it('undefined contactId (same guard) → skips', async () => {
    const result = await pushEventDateToGhl(undefined, '2026-12-25');
    expect(result).toEqual({ pushed: false });
  });

  it('HighLevel not configured → skips before formatting or resolving anything', async () => {
    hl.configured.value = false;
    const result = await pushEventDateToGhl('contact-1', '2026-12-25');
    expect(result).toEqual({ pushed: false });
    expect(hl.listLocationCustomFields).not.toHaveBeenCalled();
  });

  it('missing event date → skips, zero GHL calls (the field is never resolved)', async () => {
    const result = await pushEventDateToGhl('contact-1', undefined);
    expect(result).toEqual({ pushed: false });
    expect(hl.listLocationCustomFields).not.toHaveBeenCalled();
    expect(hl.upsertContactCustomField).not.toHaveBeenCalled();
  });

  it('blank event date → skips, zero GHL calls', async () => {
    const result = await pushEventDateToGhl('contact-1', '');
    expect(result).toEqual({ pushed: false });
    expect(hl.listLocationCustomFields).not.toHaveBeenCalled();
  });

  it('malformed event date → skips, zero GHL calls', async () => {
    const result = await pushEventDateToGhl('contact-1', 'not-a-date');
    expect(result).toEqual({ pushed: false });
    expect(hl.listLocationCustomFields).not.toHaveBeenCalled();
  });

  // FIX E (#237 fix round): renamed from "...never throws" — this ONE test
  // only exercises the final-upsert-rejects case; it doesn't by itself prove
  // the general never-throws property. The OTHER cases in this describe
  // block (the 401/403 scope error above, the deadline timeout below) cover
  // the rest, each under its own honestly-scoped name.
  it('a GHL error on the final upsert fails soft — logs, resolves pushed:false rather than rejecting', async () => {
    hl.listLocationCustomFields.mockResolvedValue([{ id: 'field-1', name: EVENT_DATE_FIELD_NAME }]);
    hl.upsertContactCustomField.mockRejectedValue(new hl.HighLevelError('GHL down', 502));

    await expect(pushEventDateToGhl('contact-1', '2026-12-25')).resolves.toEqual({ pushed: false });
  });

  it('a 401/403 scope error on field resolution fails soft and does not poison the cache', async () => {
    hl.listLocationCustomFields.mockRejectedValueOnce(new hl.HighLevelError('no scope', 403));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const first = await pushEventDateToGhl('contact-1', '2026-12-25');
    expect(first).toEqual({ pushed: false });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('lack the customFields scope'));

    // Next call retries resolution from scratch instead of reusing a poisoned
    // null cache — the scope gets fixed, the very next push should succeed.
    hl.listLocationCustomFields.mockResolvedValueOnce([{ id: 'field-1', name: EVENT_DATE_FIELD_NAME }]);
    const second = await pushEventDateToGhl('contact-1', '2026-12-25');
    expect(second).toEqual({ pushed: true });

    errSpy.mockRestore();
  });
});

describe('pushEventDateToGhl — deadline', () => {
  it('times out after PUSH_DEADLINE_MS and resolves pushed:false without throwing', async () => {
    vi.useFakeTimers();
    // Never resolves — simulates a hung GHL call so the deadline is the only
    // thing that can settle the outer promise.
    hl.listLocationCustomFields.mockImplementation(() => new Promise(() => {}));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const resultPromise = pushEventDateToGhl('contact-1', '2026-12-25');
    await vi.advanceTimersByTimeAsync(6000);
    const result = await resultPromise;

    expect(result).toEqual({ pushed: false });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('push timed out'));

    errSpy.mockRestore();
    vi.useRealTimers();
  });

  it('does NOT time out when the real work finishes well within the deadline', async () => {
    vi.useFakeTimers();
    hl.listLocationCustomFields.mockResolvedValue([{ id: 'field-1', name: EVENT_DATE_FIELD_NAME }]);

    const result = await pushEventDateToGhl('contact-1', '2026-12-25');

    expect(result).toEqual({ pushed: true });
    vi.useRealTimers();
  });
});

describe('pushEventDateToGhl — happy path', () => {
  it('pushes the MM/DD/YYYY-formatted date to the field id resolved by name', async () => {
    hl.listLocationCustomFields.mockResolvedValue([
      { id: 'other-field', name: 'Some Other Field' },
      { id: 'field-42', name: EVENT_DATE_FIELD_NAME },
    ]);

    const result = await pushEventDateToGhl('hl-contact-1', '2026-12-25');

    expect(result).toEqual({ pushed: true });
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('hl-contact-1', 'field-42', '12/25/2026');
    expect(hl.createLocationCustomField).not.toHaveBeenCalled();
  });
});

describe('pushEventDateToGhl — field resolution (create-if-missing + cache)', () => {
  it('creates the field when no existing field matches the name, then uses the created id', async () => {
    hl.listLocationCustomFields.mockResolvedValue([{ id: 'unrelated', name: 'Not It' }]);
    hl.createLocationCustomField.mockResolvedValue({ id: 'brand-new-field', name: EVENT_DATE_FIELD_NAME });

    const result = await pushEventDateToGhl('hl-1', '2026-12-25');

    expect(result).toEqual({ pushed: true });
    expect(hl.createLocationCustomField).toHaveBeenCalledWith({ name: EVENT_DATE_FIELD_NAME, dataType: 'TEXT' });
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('hl-1', 'brand-new-field', '12/25/2026');
  });

  it('matches an existing field by name with different casing + surrounding whitespace, without creating a duplicate', async () => {
    hl.listLocationCustomFields.mockResolvedValue([{ id: 'hand-created', name: '  event DATE  ' }]);

    const result = await pushEventDateToGhl('hl-1', '2026-12-25');

    expect(result).toEqual({ pushed: true });
    expect(hl.createLocationCustomField).not.toHaveBeenCalled();
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('hl-1', 'hand-created', '12/25/2026');
  });

  it('refuses to create when the list comes back EMPTY (probable parse bug), never auto-creates', async () => {
    hl.listLocationCustomFields.mockResolvedValue([]);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await pushEventDateToGhl('hl-1', '2026-12-25');

    expect(result).toEqual({ pushed: false });
    expect(hl.createLocationCustomField).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('EMPTY'));
    errSpy.mockRestore();
  });

  it('picks the lowest id deterministically when duplicate fields match the name', async () => {
    hl.listLocationCustomFields.mockResolvedValue([
      { id: 'field-b', name: EVENT_DATE_FIELD_NAME },
      { id: 'field-a', name: EVENT_DATE_FIELD_NAME },
    ]);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await pushEventDateToGhl('hl-1', '2026-12-25');

    expect(result).toEqual({ pushed: true });
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('hl-1', 'field-a', '12/25/2026');
    warnSpy.mockRestore();
  });

  it('caches the resolved field id across calls — a second push does not re-list', async () => {
    hl.listLocationCustomFields.mockResolvedValue([{ id: 'field-1', name: EVENT_DATE_FIELD_NAME }]);

    await pushEventDateToGhl('hl-1', '2026-12-25');
    await pushEventDateToGhl('hl-2', '2026-12-26');

    expect(hl.listLocationCustomFields).toHaveBeenCalledTimes(1);
    expect(hl.upsertContactCustomField).toHaveBeenCalledWith('hl-2', 'field-1', '12/26/2026');
  });

  it('clears the cache on an upsert failure so the next push re-resolves instead of reusing a dead id', async () => {
    hl.listLocationCustomFields.mockResolvedValueOnce([{ id: 'field-1', name: EVENT_DATE_FIELD_NAME }]);
    hl.upsertContactCustomField.mockRejectedValueOnce(new hl.HighLevelError('field deleted', 422));

    const first = await pushEventDateToGhl('hl-1', '2026-12-25');
    expect(first).toEqual({ pushed: false });

    // Field was deleted/renamed in GHL — re-lists and finds the new id.
    hl.listLocationCustomFields.mockResolvedValueOnce([{ id: 'field-2', name: EVENT_DATE_FIELD_NAME }]);
    const second = await pushEventDateToGhl('hl-1', '2026-12-25');

    expect(second).toEqual({ pushed: true });
    expect(hl.listLocationCustomFields).toHaveBeenCalledTimes(2);
    expect(hl.upsertContactCustomField).toHaveBeenLastCalledWith('hl-1', 'field-2', '12/25/2026');
  });
});
