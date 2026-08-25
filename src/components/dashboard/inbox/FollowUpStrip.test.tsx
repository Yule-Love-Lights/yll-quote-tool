// FollowUpStrip had no test file before row 305/309 — added alongside the fix
// rather than leaving this sibling untested (see AGENTS.md's sibling-guard-
// parity pitfall). Same no-jsdom approach as InboxList.test.tsx /
// InWorksSection.test.tsx / ActivityLog.test.tsx: a static render via
// react-dom/server proves the INITIAL render; the busyIds per-item map
// contract is pinned directly against the exported pure helpers
// (withRowFlagSet/withRowFlagCleared) that markDone actually calls, since a
// static render can't drive the async click-then-fetch flow (no jsdom in
// this repo).

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Row 365: markDone now calls router.refresh() so the anchored inbox item the
// route resolves server-side (#252 slice E) leaves the main list immediately
// instead of lingering until the next 25s poll. useRouter throws outside an
// app-router context and this component calls it unconditionally (hook-order
// rules), so it is mocked here — same shape as InboxList.test.tsx's own mock.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));
import { FollowUpStrip, withRowFlagSet, withRowFlagCleared, reconcileDueFollowUps, reChaseLabel } from './FollowUpStrip';
import type { DueFollowUp } from '@/lib/dashboard/inbox/types';

const baseItem: DueFollowUp = {
  id: 'f1',
  reason: 'quote_sent_no_reply',
  dueAt: '2026-08-20T12:00:00Z',
  contactName: 'Jane Doe',
  contactPhone: null,
  contactEmail: null,
  reChaseSince: null,
};

describe('FollowUpStrip (initial render)', () => {
  it('renders one row per due follow-up, with the friendly reason label and a Done button', () => {
    const html = renderToStaticMarkup(<FollowUpStrip initialItems={[baseItem]} />);
    expect(html).toContain('Jane Doe');
    expect(html).toContain('Quote sent — no reply');
    expect(html).toContain('Done');
    expect(html).toContain('Follow-ups due today (1)');
  });

  it('falls through to the raw reason string for an unmapped reason', () => {
    const html = renderToStaticMarkup(
      <FollowUpStrip initialItems={[{ ...baseItem, id: 'f2', reason: 'some_future_reason' }]} />,
    );
    expect(html).toContain('some_future_reason');
  });

  it('renders nothing when there are no due follow-ups', () => {
    expect(renderToStaticMarkup(<FollowUpStrip initialItems={[]} />)).toBe('');
  });

  it('a fresh render never shows a disabled Done button — busyIds always starts empty', () => {
    const html = renderToStaticMarkup(<FollowUpStrip initialItems={[baseItem]} />);
    expect(html).not.toContain('disabled=""');
  });

  // Row 390: a first-time nudge (reChaseSince null, baseItem's own default)
  // renders no re-chase badge at all — this is the case the ledger row says
  // must stay visually plain.
  it('renders no re-chase badge for an ordinary first-time nudge', () => {
    const html = renderToStaticMarkup(<FollowUpStrip initialItems={[baseItem]} />);
    expect(html).not.toContain('Re-chase');
  });

  // Row 390: the actual fix — a re-chase (reChaseSince set) is now visually
  // distinct from a first-time nudge, with the silence duration shown.
  it('renders a re-chase badge with the silence duration for a re-armed nudge', () => {
    const nineDaysAgo = new Date(Date.now() - 9 * 86_400_000).toISOString();
    const html = renderToStaticMarkup(
      <FollowUpStrip initialItems={[{ ...baseItem, reChaseSince: nineDaysAgo }]} />,
    );
    expect(html).toContain('Re-chase — quiet 9d');
  });
});

// Row 390: reChaseLabel is the exact pure primitive the render above calls —
// tells a re-chase apart from a first-time nudge (null reChaseSince) and
// renders the silence duration, so staff can tell "we never chased this"
// from "we chased once and they went quiet again". Pure and exported per
// this file's own testing convention (no jsdom — extract + test the pure
// piece, mirroring reconcileDueFollowUps below).
describe('reChaseLabel (row 390 — re-chase marker + silence duration)', () => {
  const now = new Date('2026-08-25T12:00:00Z');

  it('returns null for an ordinary first-time nudge (reChaseSince null)', () => {
    expect(reChaseLabel(null, now)).toBeNull();
  });

  it('returns null for an unparseable timestamp — degrades to "no badge", never a garbled one', () => {
    expect(reChaseLabel('not-a-date', now)).toBeNull();
  });

  it('reports whole days of silence, floored', () => {
    const sevenAndAHalfDaysAgo = new Date(now.getTime() - 7.5 * 86_400_000).toISOString();
    expect(reChaseLabel(sevenAndAHalfDaysAgo, now)).toBe('Re-chase — quiet 7d');
  });

  it('reports 0d rather than a negative number for a since-time in the future (clock skew)', () => {
    const inTheFuture = new Date(now.getTime() + 60_000).toISOString();
    expect(reChaseLabel(inTheFuture, now)).toBe('Re-chase — quiet 0d');
  });

  it('reports exactly 0d the instant the re-chase fires', () => {
    expect(reChaseLabel(now.toISOString(), now)).toBe('Re-chase — quiet 0d');
  });
});

// Row 305 (WRAP TECHNICAL LENS widening): withRowFlagSet/withRowFlagCleared
// are the exact pure primitives markDone now calls to read/write the per-row
// busyIds map, replacing the single-slot `busyId` that let marking follow-up
// B done re-enable follow-up A's Done button mid-flight — markFollowUpDone
// (store.ts) has no server-side guard, so that double-fire was a real risk
// (worst case: a duplicate activity row). Mirrors InboxList.test.tsx /
// InWorksSection.test.tsx / ActivityLog.test.tsx's own coverage of their
// identical local copies.
describe('withRowFlagSet / withRowFlagCleared (row 305 — per-row busy map)', () => {
  it('setting the flag for two different row ids leaves both present simultaneously', () => {
    let busyIds: Record<string, boolean> = {};
    busyIds = withRowFlagSet(busyIds, 'f1');
    busyIds = withRowFlagSet(busyIds, 'f2');
    expect(busyIds).toEqual({ f1: true, f2: true });
  });

  it('clearing one row\'s flag leaves another row\'s entry untouched — the fix for "marking B done re-enables A mid-flight"', () => {
    let busyIds: Record<string, boolean> = { f1: true, f2: true };
    busyIds = withRowFlagCleared(busyIds, 'f2');
    expect(busyIds).toEqual({ f1: true }); // f1 (still in flight) stays disabled
  });

  it('clearing a flag for an id that was never set is a no-op that returns the SAME object reference', () => {
    const busyIds: Record<string, boolean> = { f1: true };
    expect(withRowFlagCleared(busyIds, 'f2')).toBe(busyIds);
  });
});

const f2: DueFollowUp = { ...baseItem, id: 'f2', contactName: 'John Smith' };

// Row 309: reconcileDueFollowUps is the exact pure primitive the mount-time-
// only useState(initialItems) needed to become reactive to a fresh
// router.refresh()-driven prop without resurrecting a row this component is
// still actively submitting — see its own doc comment in FollowUpStrip.tsx
// for the full race trace (an unrelated action's refresh landing while THIS
// component's own markDone is still in flight for a different row).
describe('reconcileDueFollowUps (row 309 — reacting to a fresh initialItems without resurrecting a busy row)', () => {
  it('passes through a fresh list unchanged when nothing is busy', () => {
    expect(reconcileDueFollowUps([baseItem, f2], {})).toEqual([baseItem, f2]);
  });

  it('drops a row that is no longer in the fresh list — the actual staleness fix: a retired follow-up disappears', () => {
    // Server truth after a sibling action's router.refresh(): f1 retired (its
    // conversation reached completed/dismissed), f2 still due.
    expect(reconcileDueFollowUps([f2], {})).toEqual([f2]);
  });

  it('picks up a NEW row that became due since mount — the "additive" half', () => {
    const brandNew: DueFollowUp = { ...baseItem, id: 'f3', contactName: 'New Since Mount' };
    expect(reconcileDueFollowUps([baseItem, brandNew], {})).toEqual([baseItem, brandNew]);
  });

  it('excludes a row that is currently busy even though the fresh list still includes it — THE resurrection this fix prevents', () => {
    // f1's own markDone POST hasn't resolved server-side yet, so the fresh
    // follow_ups query can legitimately still return it.
    expect(reconcileDueFollowUps([baseItem, f2], { f1: true })).toEqual([f2]);
  });

  it('a row busy in a PRIOR render but no longer in busyIds is no longer excluded', () => {
    expect(reconcileDueFollowUps([baseItem, f2], {})).toEqual([baseItem, f2]);
  });
});
