// Row 291 fix: InWorksSection had NO test file before this — added alongside
// the fix rather than leaving this sibling untested (InboxList.tsx carries
// the identical bug and now has coverage for it; per AGENTS.md's sibling-
// guard-parity pitfall, fixing one half without the other — code OR tests —
// is a failed build). Same no-jsdom approach as InboxList.test.tsx /
// CustomerReferralPanel.test.tsx / ReferredByPicker.test.tsx: a static
// render via react-dom/server proves the INITIAL render (both buckets show,
// both items render independently); the busyIds/errorIds per-item map
// contract itself is pinned directly against the exported pure helpers
// (withRowFlagSet/withRowFlagCleared) that act()/dismissError actually call,
// since a static render can't drive the async click-then-fetch flow that
// would otherwise require jsdom + a mocked fetch (not this repo's idiom —
// no jsdom/testing-library dependency exists here).

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InWorksSection, withRowFlagSet, withRowFlagCleared } from './InWorksSection';
import type { InWorksItem } from '@/lib/dashboard/inbox/store';

const now = 1_000_000_000_000;
const at = (msAgo: number) => new Date(now - msAgo).toISOString();

const baseItem: InWorksItem = {
  id: 'x',
  source: 'ghl',
  channel: null,
  preview: null,
  customerName: null,
  lastActivityAt: null,
};

describe('InWorksSection (row 291 — initial render)', () => {
  it('renders one row per item in each of the awaiting/handled buckets, independently', () => {
    const awaiting: InWorksItem[] = [
      { ...baseItem, id: 'a1', customerName: 'Awaiting Customer', lastActivityAt: at(3_600_000) },
    ];
    const handled: InWorksItem[] = [
      { ...baseItem, id: 'h1', customerName: 'Handled Customer', lastActivityAt: at(7_200_000) },
    ];
    const html = renderToStaticMarkup(
      <InWorksSection awaiting={awaiting} handled={handled} followUpDays={3} nowMs={now} />,
    );
    expect(html).toContain('Awaiting Customer');
    expect(html).toContain('Handled Customer');
    expect(html).toContain('Awaiting their reply (1)');
    expect(html).toContain('Handled (1)');
  });

  it('renders nothing when both buckets are empty', () => {
    const html = renderToStaticMarkup(
      <InWorksSection awaiting={[]} handled={[]} followUpDays={3} nowMs={now} />,
    );
    expect(html).toBe('');
  });

  it('a fresh render never shows an error note or a disabled "Mark completed" — busyIds/errorIds always start empty', () => {
    const handled: InWorksItem[] = [
      { ...baseItem, id: 'h1', customerName: 'Handled Customer', lastActivityAt: at(3_600_000) },
    ];
    const html = renderToStaticMarkup(
      <InWorksSection awaiting={[]} handled={handled} followUpDays={3} nowMs={now} />,
    );
    expect(html).not.toContain('Something went wrong');
    expect(html).not.toContain('Saving…');
  });
});

// Row 291 fix: withRowFlagSet/withRowFlagCleared are the exact pure
// primitives act() and dismissError call to read/write the per-item
// busyIds/errorIds maps — see their own doc comment in InWorksSection.tsx.
// These pin the ledger-291 bug directly at the level of that shared logic,
// the same way InboxList.test.tsx pins its own copy of the identical fix.
describe('withRowFlagSet / withRowFlagCleared (row 291 — per-item busy/error maps)', () => {
  it('setting the flag for two different row ids leaves both present simultaneously — the fix for "only one row can show an error at a time"', () => {
    let errorIds: Record<string, boolean> = {};
    errorIds = withRowFlagSet(errorIds, 'rowA');
    errorIds = withRowFlagSet(errorIds, 'rowB');
    expect(errorIds).toEqual({ rowA: true, rowB: true });
  });

  it('acting on row B (clearing its error on the way into a fresh act() call) does NOT clear row A\'s still-true error', () => {
    const bothErrored: Record<string, boolean> = { rowA: true, rowB: true };
    const afterActingOnRowB = withRowFlagCleared(bothErrored, 'rowB');
    expect(afterActingOnRowB).toEqual({ rowA: true });
  });

  it('dismissing row A\'s error leaves row B\'s error intact', () => {
    const bothErrored: Record<string, boolean> = { rowA: true, rowB: true };
    const afterDismissingRowA = withRowFlagCleared(bothErrored, 'rowA');
    expect(afterDismissingRowA).toEqual({ rowB: true });
  });

  it('the same set/clear primitives used for busyIds keep one row\'s busy state from touching an unrelated row\'s — a row going busy or finishing does not disable or spin a sibling row', () => {
    let busyIds: Record<string, boolean> = {};
    busyIds = withRowFlagSet(busyIds, 'rowA');
    busyIds = withRowFlagSet(busyIds, 'rowB');
    expect(busyIds).toEqual({ rowA: true, rowB: true });
    busyIds = withRowFlagCleared(busyIds, 'rowA');
    expect(busyIds).toEqual({ rowB: true });
  });

  it('clearing a flag for an id that was never set is a no-op that returns the SAME object reference', () => {
    const errorIds: Record<string, boolean> = { rowA: true };
    expect(withRowFlagCleared(errorIds, 'rowB')).toBe(errorIds);
  });
});
