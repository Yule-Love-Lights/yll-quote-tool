// Smoke coverage for the #252 slice D rollup — renders with react-dom/server
// (same no-jsdom approach as CustomerReferralPanel.test.tsx /
// ReferredByPicker.test.tsx). Effects (the 25s poll, the 30s clock tick)
// don't run under a static render, so this only proves the INITIAL render:
// a single-conversation contact stays a bare row, and a multi-conversation
// contact collapses into one rolled-up row instead of N separate ones. The
// grouping/sorting logic itself is covered exhaustively in
// groupInboxItems.test.ts; this just proves InboxList actually wires it in.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InboxList, isGroupExpanded } from './InboxList';
import type { OpenInboxItem } from '@/lib/dashboard/inbox/types';
import type { InboxGroup } from '@/lib/dashboard/inbox/groupInboxItems';

const base: OpenInboxItem = {
  id: 'x', source: 'ghl', channel: null, direction: null, lastMessageAt: null, preview: null,
  subject: null, escalationLevel: 0, leadKind: 'lead', quoteValue: null, isReturning: false,
  contactId: null, assignedTo: null, contact: null,
};
const now = 1_000_000_000_000;
const at = (msAgo: number) => new Date(now - msAgo).toISOString();

// Minimal InboxGroup fixture builder for the pure isGroupExpanded tests below
// — doesn't need groupInboxItems' real sort, just a shape that satisfies the
// type.
function makeGroup(members: OpenInboxItem[]): InboxGroup {
  return {
    key: members[0].contactId ?? `item:${members[0].id}`,
    contactId: members[0].contactId,
    members,
    primary: members[0],
    newest: members[members.length - 1],
    sourceCounts: {},
  };
}

describe('InboxList (#252 slice D rollup)', () => {
  it('renders a single-conversation contact as one bare row (no group header)', () => {
    const items: OpenInboxItem[] = [
      { ...base, id: 'solo', source: 'gmail', contactId: 'c1', contact: { displayName: 'Solo Customer', email: null, phone: null }, lastMessageAt: at(3 * 3_600_000) },
    ];
    const html = renderToStaticMarkup(<InboxList initialItems={items} nowMs={now} />);
    expect(html).toContain('Solo Customer');
    expect(html).not.toContain('aria-expanded');
  });

  it('rolls up a multi-source contact into ONE row with a per-source badge and an expand control', () => {
    const items: OpenInboxItem[] = [
      { ...base, id: 'e1', source: 'gmail', contactId: 'c2', contact: { displayName: 'Multi Channel', email: null, phone: null }, preview: 'the newest thing they said', lastMessageAt: at(1 * 3_600_000) },
      { ...base, id: 'e2', source: 'gmail', contactId: 'c2', contact: { displayName: 'Multi Channel', email: null, phone: null }, lastMessageAt: at(5 * 3_600_000) },
      { ...base, id: 'g1', source: 'ghl', contactId: 'c2', contact: { displayName: 'Multi Channel', email: null, phone: null }, lastMessageAt: at(2 * 3_600_000) },
    ];
    const html = renderToStaticMarkup(<InboxList initialItems={items} nowMs={now} />);
    // Only ONE "Multi Channel" name renders (the collapsed group header),
    // not three — proves the fold actually happened, not just a passthrough.
    expect(html.match(/Multi Channel/g)?.length).toBe(1);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Gmail ×2');
    expect(html).toContain('GHL ×1');
    expect(html).toContain('the newest thing they said');
  });

  it('a null-contactId item never merges with another null-contactId item', () => {
    const items: OpenInboxItem[] = [
      { ...base, id: 'u1', source: 'gmail', contactId: null, contact: { displayName: 'Unlinked One', email: null, phone: null }, lastMessageAt: at(3 * 3_600_000) },
      { ...base, id: 'u2', source: 'ghl', contactId: null, contact: { displayName: 'Unlinked Two', email: null, phone: null }, lastMessageAt: at(1 * 3_600_000) },
    ];
    const html = renderToStaticMarkup(<InboxList initialItems={items} nowMs={now} />);
    expect(html).toContain('Unlinked One');
    expect(html).toContain('Unlinked Two');
    expect(html).not.toContain('aria-expanded');
  });
});

// #270 fix round (staff HIGH, part c): the pin/auto-expand decision extracted
// as a pure function so it's directly unit-testable without rendering — the
// actual DOM-remount claim (why a stable component/key avoids losing
// ReplyComposer's draft) is proven by the reconciliation trace in
// ContactRow's own doc comment in InboxList.tsx, not by a test here (a
// jsdom-free static render can't observe remounts).
describe('isGroupExpanded (#270 fix — composer pin)', () => {
  it('forces expanded=true when composerFor points at a member of the group, even with no expandedMap entry', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, {}, 'm1')).toBe(true);
  });

  it('forces expanded=true for composerFor even when the SAME group key was explicitly collapsed in expandedMap', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, { c1: false }, 'm2')).toBe(true);
  });

  it('falls back to the raw expandedMap value when composerFor is null', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, { c1: true }, null)).toBe(true);
    expect(isGroupExpanded(group, {}, null)).toBe(false);
  });

  it('does not force-expand a DIFFERENT group just because some other group has the open composer', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, {}, 'someone-elses-item-id')).toBe(false);
  });
});
