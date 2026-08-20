// FollowUpStrip had no test file before row 305/309 — added alongside the fix
// rather than leaving this sibling untested (see AGENTS.md's sibling-guard-
// parity pitfall). Same no-jsdom approach as InboxList.test.tsx /
// InWorksSection.test.tsx / ActivityLog.test.tsx: a static render via
// react-dom/server proves the INITIAL render; the busyIds per-item map
// contract is pinned directly against the exported pure helpers
// (withRowFlagSet/withRowFlagCleared) that markDone actually calls, since a
// static render can't drive the async click-then-fetch flow (no jsdom in
// this repo).

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FollowUpStrip, withRowFlagSet, withRowFlagCleared, reconcileDueFollowUps } from './FollowUpStrip';
import type { DueFollowUp } from '@/lib/dashboard/inbox/types';

const baseItem: DueFollowUp = {
  id: 'f1',
  reason: 'quote_sent_no_reply',
  dueAt: '2026-08-20T12:00:00Z',
  contactName: 'Jane Doe',
  contactPhone: null,
  contactEmail: null,
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
