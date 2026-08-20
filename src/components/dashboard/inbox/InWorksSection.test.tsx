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
import {
  InWorksSection,
  withRowFlagSet,
  withRowFlagCleared,
  requiresCompleteConfirmation,
  omitKey,
  clearNeedsLookOnMove,
  errorNoteFor,
} from './InWorksSection';
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
  needsLookReason: null,
};

describe('InWorksSection (row 291 — initial render)', () => {
  // #307: the settled-Handled subsection now starts COLLAPSED (see the
  // "Needs a look split" describe block below for that behavior directly), so
  // this row is given a needsLookReason — it renders under "Needs a look",
  // which is always expanded — to keep proving "one row per item, in each
  // bucket, independently" on the very first render.
  it('renders one row per item in each of the awaiting/handled buckets, independently', () => {
    const awaiting: InWorksItem[] = [
      { ...baseItem, id: 'a1', customerName: 'Awaiting Customer', lastActivityAt: at(3_600_000) },
    ];
    const handled: InWorksItem[] = [
      { ...baseItem, id: 'h1', customerName: 'Handled Customer', lastActivityAt: at(7_200_000), needsLookReason: 'Quote unanswered' },
    ];
    const html = renderToStaticMarkup(
      <InWorksSection awaiting={awaiting} handled={handled} followUpDays={3} nowMs={now} />,
    );
    expect(html).toContain('Awaiting Customer');
    expect(html).toContain('Handled Customer');
    expect(html).toContain('Awaiting their reply (1)');
    expect(html).toContain('Needs a look (1)');
  });

  // #252 slice H: "Awaiting their reply" and the main "Open leads" queue both
  // read as "awaiting reply" at a glance — this sub-copy spells out who owes
  // whom, and only appears alongside the bucket it describes.
  //
  // Row-292/staff-lens fix: the bucket admits rows via TWO paths — an actual
  // reply (ReplyComposer → markItemFollowed) AND the standalone "Followed"
  // button (src/app/api/dashboard/followed/route.ts, "No source write-back"),
  // which stamps followed_up_at with no reply ever sent. The caption must be
  // true for BOTH — "followed up", never "replied".
  it('clarifies "Awaiting their reply" as ball-in-their-court sub-copy, true for both the reply path and the no-reply "Followed" path, only when that bucket has items', () => {
    const awaiting: InWorksItem[] = [{ ...baseItem, id: 'a1', customerName: 'Awaiting Customer' }];
    const withAwaiting = renderToStaticMarkup(
      <InWorksSection awaiting={awaiting} handled={[]} followUpDays={3} nowMs={now} />,
    );
    expect(withAwaiting).toContain('You’ve followed up on these — nothing to do until they write back.');
    expect(withAwaiting).not.toContain('already replied');

    const handled: InWorksItem[] = [{ ...baseItem, id: 'h1', customerName: 'Handled Customer' }];
    const noAwaiting = renderToStaticMarkup(
      <InWorksSection awaiting={[]} handled={handled} followUpDays={3} nowMs={now} />,
    );
    expect(noAwaiting).not.toContain('nothing to do until they write back');
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

  // Row 311: unreachableActions (the lock state) always starts empty, same as
  // busyIds/errorIds above — a fresh render never shows a row locked to a
  // prior attempted action.
  it('a fresh render never shows a locked-button tooltip — unreachableActions always starts empty', () => {
    const handled: InWorksItem[] = [
      { ...baseItem, id: 'h1', customerName: 'Flagged Customer', needsLookReason: 'They wrote last' },
    ];
    const html = renderToStaticMarkup(
      <InWorksSection awaiting={[]} handled={handled} followUpDays={3} nowMs={now} />,
    );
    expect(html).not.toContain('Locked until');
  });
});

// #307: "Needs a look" splits the handled bucket into a rendering-only view
// (needsLookItems / settledHandledItems, both filters over the same
// handledItems state — see InWorksSection.tsx's own comment). A static render
// can prove the INITIAL split (which section a row's name appears in, whether
// the settled list is collapsed) but not the collapse/expand CLICK itself —
// that needs jsdom, which this repo doesn't have (same limitation the file's
// header comment already states for the busy/error click-then-fetch flow).
describe('InWorksSection (#307 — Needs a look split)', () => {
  it('a handled row with a needsLookReason renders under "Needs a look", not silently inside "Handled"', () => {
    const handled: InWorksItem[] = [
      { ...baseItem, id: 'h1', customerName: 'Flagged Customer', needsLookReason: 'Quote unanswered' },
    ];
    const html = renderToStaticMarkup(
      <InWorksSection awaiting={[]} handled={handled} followUpDays={3} nowMs={now} />,
    );
    expect(html).toContain('Needs a look (1)');
    expect(html).toContain('Flagged Customer');
    expect(html).toContain('Quote unanswered');
    // No settled rows in this fixture, so the Handled subsection never renders.
    expect(html).not.toContain('Handled (');
  });

  it('a handled row with no needsLookReason renders under "Handled", not "Needs a look"', () => {
    const handled: InWorksItem[] = [
      { ...baseItem, id: 'h1', customerName: 'Settled Customer', needsLookReason: null },
    ];
    const html = renderToStaticMarkup(
      <InWorksSection awaiting={[]} handled={handled} followUpDays={3} nowMs={now} />,
    );
    expect(html).toContain('Handled (1)');
    expect(html).not.toContain('Needs a look');
  });

  it('the Handled subsection starts COLLAPSED — its row name is absent from the initial render even though the count shows', () => {
    const handled: InWorksItem[] = [
      { ...baseItem, id: 'h1', customerName: 'Should Be Hidden Initially', needsLookReason: null },
    ];
    const html = renderToStaticMarkup(
      <InWorksSection awaiting={[]} handled={handled} followUpDays={3} nowMs={now} />,
    );
    expect(html).toContain('Handled (1)');
    expect(html).not.toContain('Should Be Hidden Initially');
  });

  it('a mixed handled bucket splits: the flagged row\'s name appears (Needs a look renders expanded), the settled row\'s name does not (Handled starts collapsed)', () => {
    const handled: InWorksItem[] = [
      { ...baseItem, id: 'h1', customerName: 'Flagged One', needsLookReason: 'They wrote last' },
      { ...baseItem, id: 'h2', customerName: 'Settled One', needsLookReason: null },
    ];
    const html = renderToStaticMarkup(
      <InWorksSection awaiting={[]} handled={handled} followUpDays={3} nowMs={now} />,
    );
    expect(html).toContain('Needs a look (1)');
    expect(html).toContain('Flagged One');
    expect(html).toContain('Handled (1)');
    expect(html).not.toContain('Settled One');
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

  it('helper: the clear act() runs for row B on entry leaves row A\'s entry untouched', () => {
    const bothErrored: Record<string, boolean> = { rowA: true, rowB: true };
    const afterActingOnRowB = withRowFlagCleared(bothErrored, 'rowB');
    expect(afterActingOnRowB).toEqual({ rowA: true });
  });

  it('helper: the clear dismissError runs for row A leaves row B\'s entry intact', () => {
    const bothErrored: Record<string, boolean> = { rowA: true, rowB: true };
    const afterDismissingRowA = withRowFlagCleared(bothErrored, 'rowA');
    expect(afterDismissingRowA).toEqual({ rowB: true });
  });

  it('helper: set/clear on one busy id never adds or removes another id\'s entry', () => {
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

// #307 review fix 1: pins the pure predicate handleMarkCompleted's confirm
// gate is built on — see requiresCompleteConfirmation's own doc comment in
// InWorksSection.tsx. The click-then-confirm-then-act flow itself can't be
// driven without jsdom (same limitation as the rest of this file), but the
// decision rule that flow depends on is fully covered here.
describe('requiresCompleteConfirmation (#307 review fix 1 — pure)', () => {
  it('is true for a row carrying a needsLookReason', () => {
    expect(requiresCompleteConfirmation({ needsLookReason: 'Quote unanswered' })).toBe(true);
  });

  it('is false for a row with no needsLookReason (today\'s one-click behavior is unchanged)', () => {
    expect(requiresCompleteConfirmation({ needsLookReason: null })).toBe(false);
  });
});

// #307 review fix 2: evidenceIncomplete must render its note even when the
// "Needs a look" heading itself does not (zero flagged rows) — that's the
// exact silent-undercount scenario the flag exists to surface.
describe('InWorksSection (#307 review fix 2 — evidenceIncomplete banner)', () => {
  it('shows no incomplete-evidence note when evidenceIncomplete is omitted (default false)', () => {
    const handled: InWorksItem[] = [
      { ...baseItem, id: 'h1', customerName: 'Settled Customer', needsLookReason: null },
    ];
    const html = renderToStaticMarkup(
      <InWorksSection awaiting={[]} handled={handled} followUpDays={3} nowMs={now} />,
    );
    expect(html).not.toContain('evidence checks');
  });

  it('shows the incomplete-evidence note even when zero rows are flagged (the "Needs a look" heading never renders)', () => {
    const handled: InWorksItem[] = [
      { ...baseItem, id: 'h1', customerName: 'Settled Customer', needsLookReason: null },
    ];
    const html = renderToStaticMarkup(
      <InWorksSection
        awaiting={[]}
        handled={handled}
        followUpDays={3}
        nowMs={now}
        evidenceIncomplete={true}
      />,
    );
    // The heading (which always carries a "(" count) never renders; only the
    // banner's own prose mentions "Needs a look" by name.
    expect(html).not.toContain('Needs a look (');
    expect(html).toContain('evidence checks');
  });

  it('shows the incomplete-evidence note alongside a populated "Needs a look" list too', () => {
    const handled: InWorksItem[] = [
      { ...baseItem, id: 'h1', customerName: 'Flagged Customer', needsLookReason: 'They wrote last' },
    ];
    const html = renderToStaticMarkup(
      <InWorksSection
        awaiting={[]}
        handled={handled}
        followUpDays={3}
        nowMs={now}
        evidenceIncomplete={true}
      />,
    );
    expect(html).toContain('Needs a look (1)');
    expect(html).toContain('evidence checks');
  });
});

// #307 review fix 3: the collapsed Handled toggle previously read the same
// static "Handled (N)" whether the list below was open or closed. A static
// render can only ever prove the INITIAL (collapsed) state — see this file's
// header comment — but that's enough to pin that the label is now
// state-aware (says "Show", not the old bare count) rather than static.
describe('InWorksSection (#307 review fix 3 — Handled toggle label feedback)', () => {
  it('the collapsed Handled toggle reads "Show Handled (N)", not the old bare "Handled (N)"', () => {
    const handled: InWorksItem[] = [
      { ...baseItem, id: 'h1', customerName: 'Settled Customer', needsLookReason: null },
    ];
    const html = renderToStaticMarkup(
      <InWorksSection awaiting={[]} handled={handled} followUpDays={3} nowMs={now} />,
    );
    expect(html).toContain('Show Handled (1)');
    expect(html).not.toContain('Hide Handled');
  });
});

// Row 311 (10th sibling-parity instance — the LOCK half of #806/#302 that this
// file never got): a local copy of InboxList.tsx's own omitKey (#302), used to
// clear a row's recorded unreachableActions entry. Mirrors
// InboxList.test.tsx's own omitKey coverage.
describe('omitKey (row 311 — clearing the recorded unreachable action)', () => {
  it('removes only the named key', () => {
    expect(omitKey({ a: 'Followed', b: 'Mark completed' }, 'a')).toEqual({ b: 'Mark completed' });
  });

  it('returns the SAME reference when the key is absent, so an unaffected row does not re-render', () => {
    const map = { a: 'Followed' };
    expect(omitKey(map, 'missing')).toBe(map);
  });

  it('does not mutate the input map', () => {
    const map = { a: 'Followed', b: 'Mark completed' };
    omitKey(map, 'a');
    expect(map).toEqual({ a: 'Followed', b: 'Mark completed' });
  });

  it('leaves an empty map alone, same reference', () => {
    const map: Record<string, string> = {};
    expect(omitKey(map, 'a')).toBe(map);
  });
});

// Row 311 fold-in (LOW): moveGroup applies this transform to a row on the way
// into its new bucket — see clearNeedsLookOnMove's own doc comment in
// InWorksSection.tsx for why a genuine client-side transition always resolves
// the flag.
describe('clearNeedsLookOnMove (row 311 fold-in — LOW)', () => {
  it('clears a set needsLookReason', () => {
    const item = { id: 'h1', needsLookReason: 'Quote unanswered' };
    expect(clearNeedsLookOnMove(item)).toEqual({ id: 'h1', needsLookReason: null });
  });

  it('is a no-op (same reference) when needsLookReason is already null', () => {
    const item = { id: 'a1', needsLookReason: null };
    expect(clearNeedsLookOnMove(item)).toBe(item);
  });

  it('leaves every other field on the item untouched', () => {
    const item = { id: 'h1', customerName: 'Flagged Customer', needsLookReason: 'They wrote last' };
    expect(clearNeedsLookOnMove(item)).toEqual({
      id: 'h1',
      customerName: 'Flagged Customer',
      needsLookReason: null,
    });
  });
});

// Row 311 fix-round FIX 3: a local copy of InboxList.tsx's own errorNoteFor —
// before this, a definite server rejection's own `data.error` was discarded.
describe('errorNoteFor (row 311 fix-round FIX 3)', () => {
  it('a thrown fetch always wins, regardless of any rejection error also present', () => {
    expect(errorNoteFor('Followed', 'Already marked followed')).toBe(
      "Couldn't reach the server — this may or may not have gone through. Click Followed again to confirm.",
    );
  });

  it('a definite rejection with an error renders that error, not the generic fallback', () => {
    expect(errorNoteFor(undefined, 'Already marked followed')).toBe('Already marked followed');
  });

  it('a definite rejection with no error falls back to the generic copy', () => {
    expect(errorNoteFor(undefined, undefined)).toBe('Something went wrong — try again.');
  });
});
