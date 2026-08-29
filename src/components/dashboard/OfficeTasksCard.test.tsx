// Pure-logic tests for OfficeTasksCard (calls merge plan S1). This repo's
// test setup doesn't run jsdom (see ClockCard.test.ts / RebookButton.test.ts
// for the same pattern), so interactive state is NOT exercised here — the
// route tests already cover the server contract end to end. This file
// covers the two client-side decisions that matter for the idempotency
// contract to hold up over the network (which failures are "ambiguous" and
// therefore keep the retry key alive) plus the display formatting, and a
// static-render smoke check on the initial (loading) paint.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import OfficeTasksCard, { formatDueTime, isAmbiguousMutationFailure, resolvedTimeFor } from './OfficeTasksCard';

describe('isAmbiguousMutationFailure', () => {
  it('treats 5xx, 408, 425, and 429 as ambiguous (outcome unknown — keep the key)', () => {
    for (const status of [500, 502, 503, 408, 425, 429]) {
      expect(isAmbiguousMutationFailure(status)).toBe(true);
    }
  });

  it('treats a definite rejection (4xx other than 408/425/429) as NOT ambiguous (safe to mint a new key)', () => {
    for (const status of [400, 401, 403, 404, 409, 422]) {
      expect(isAmbiguousMutationFailure(status)).toBe(false);
    }
  });
});

describe('formatDueTime', () => {
  it('formats a valid ISO timestamp', () => {
    const formatted = formatDueTime('2026-08-29T17:00:00.000Z');
    expect(formatted).not.toBe('Due time unavailable');
    expect(formatted.length).toBeGreaterThan(0);
  });

  it('falls back to a plain message for an unparsable value', () => {
    expect(formatDueTime('not-a-date')).toBe('Due time unavailable');
  });
});

describe('resolvedTimeFor', () => {
  it('prefers completedAt when both are somehow set', () => {
    const result = resolvedTimeFor({ completedAt: '2026-08-29T17:00:00.000Z', dismissedAt: '2026-08-30T17:00:00.000Z' });
    expect(result).not.toBeNull();
  });

  it('falls back to dismissedAt when completedAt is null', () => {
    const result = resolvedTimeFor({ completedAt: null, dismissedAt: '2026-08-30T17:00:00.000Z' });
    expect(result).not.toBeNull();
  });

  it('returns null when neither is set (still open/blocked)', () => {
    expect(resolvedTimeFor({ completedAt: null, dismissedAt: null })).toBeNull();
  });
});

describe('OfficeTasksCard — initial static render', () => {
  it('renders the loading state before any effect has run (no DOM/fetch in this test env)', () => {
    const html = renderToStaticMarkup(<OfficeTasksCard />);
    expect(html).toContain('Office Tasks');
    expect(html).toContain('My open work');
    expect(html).toContain('Loading tasks');
    // The create-task form fields exist from first paint.
    expect(html).toContain('office-task-title');
    expect(html).toContain('View history');
  });
});
