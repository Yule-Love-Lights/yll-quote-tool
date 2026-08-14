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
import { InboxList, isGroupExpanded, canToggleGroup } from './InboxList';
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

// #268 fix round (staff HIGH): resolveReplyTarget (reply.ts) sends every
// gmail-source row to a static "Reply in Gmail" note, which is structurally
// wrong for a #268 lead-forward — its addressable Gmail party is the
// platform's no-reply relay, and replying there reaches nobody.
//
// #268 fix round 3 (technical HIGH, fix-introduced by round 2): the original
// marker (contact.phone) was WRONG — `dashboard_contacts.primary_phone` is a
// cross-channel MERGED field, so a RETURNING customer (submitted a quote
// earlier — carries a phone — then emails sales@ normally) would show a
// phone on a genuine, replyable thread and falsely trigger the warning. The
// marker is now MESSAGE-level (parseLeadForwardDisplay on subject+preview),
// immune to contact merges since it never reads the contact.
const GML_SUBJECT = 'New Lead from GML Media - Jamie Test';
const GML_PREVIEW =
  'Here ya go Naldoven: Jamie Test +15551234567 Email: jamie.test@example.com Street Address: 42 Fake Lane City: Faketown Areas to light up: Roof Line - (Premium Package)';

describe('InboxList — #268 forwarded-lead reply affordance', () => {
  it('a gmail row whose subject+preview parse as a GML lead-forward shows the phone + the forwarded-lead wording instead of "Reply in Gmail"', () => {
    const items: OpenInboxItem[] = [
      {
        ...base,
        id: 'fwd1',
        source: 'gmail',
        contactId: 'c-fwd',
        subject: GML_SUBJECT,
        preview: GML_PREVIEW,
        contact: { displayName: 'Jamie Test', email: 'jamie.test@example.com', phone: null },
        lastMessageAt: at(1 * 3_600_000),
      },
    ];
    const html = renderToStaticMarkup(<InboxList initialItems={items} nowMs={now} />);
    expect(html).toContain('Forwarded lead');
    expect(html).toContain('no-reply relay');
    expect(html).toContain('+15551234567');
    expect(html).toContain('jamie.test@example.com');
    expect(html).not.toContain('Reply in Gmail');
  });

  it('a gmail row with an ordinary subject/preview (no GML template) shows the unchanged "Reply in Gmail" note', () => {
    const items: OpenInboxItem[] = [
      {
        ...base,
        id: 'g1',
        source: 'gmail',
        contactId: 'c-real',
        subject: 'Re: your lighting quote',
        preview: 'Thanks! Can we add the porch too?',
        contact: { displayName: 'A Real Conversation', email: 'them@example.com', phone: null },
        lastMessageAt: at(1 * 3_600_000),
      },
    ];
    const html = renderToStaticMarkup(<InboxList initialItems={items} nowMs={now} />);
    expect(html).toContain('Reply in Gmail');
    expect(html).not.toContain('Forwarded lead');
  });

  // THE EXACT HIGH this round fixes, pinned: a returning customer's ORDINARY
  // Gmail thread (real subject, real body — no GML template anywhere) whose
  // CONTACT nonetheless carries a phone (merged in from an earlier quote via
  // email-match identity resolution) must NOT trigger the false forwarded-
  // lead warning. Round 2's contact.phone-gated version would have failed
  // this test.
  it('a returning-customer shape (contact HAS a phone from an earlier quote, subject/preview are ordinary) never shows the false "Forwarded lead" warning', () => {
    const items: OpenInboxItem[] = [
      {
        ...base,
        id: 'returning1',
        source: 'gmail',
        contactId: 'c-returning',
        subject: 'Re: quote for our house',
        preview: 'Thanks so much! Can we do the front and the porch too?',
        // Merged from an earlier quotetool touch via email-match identity
        // resolution (store.ts's appendIdentifiers) — NOT from this message.
        contact: { displayName: 'Returning Customer', email: 'returning@example.com', phone: '+15551234567' },
        lastMessageAt: at(1 * 3_600_000),
      },
    ];
    const html = renderToStaticMarkup(<InboxList initialItems={items} nowMs={now} />);
    expect(html).toContain('Reply in Gmail');
    expect(html).not.toContain('Forwarded lead');
    expect(html).not.toContain('no-reply relay');
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

// #270 delta-verify fix (MED, fix-introduced by isGroupExpanded's own pin):
// a header click while composerFor pins the group open used to LOOK like a
// no-op (the pin visually overrode the display either way) but silently
// flipped the underlying expandedMap — and the instant the reply sent and
// composerFor cleared, isGroupExpanded fell back to that stale flipped
// value, snapping the group collapsed with zero visible operator action.
describe('canToggleGroup (#270 delta-verify fix — suppress toggle during pin)', () => {
  it('returns false while composerFor points at a member of the group', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
    ]);
    expect(canToggleGroup(group, 'm1')).toBe(false);
    expect(canToggleGroup(group, 'm2')).toBe(false);
  });

  it('returns true when composerFor is null or points at an item outside this group', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(canToggleGroup(group, null)).toBe(true);
    expect(canToggleGroup(group, 'someone-elses-item-id')).toBe(true);
  });

  it('a toggle click during the pin is a no-op, and releasing the pin restores the PRE-PIN expandedMap value (the exact failing sequence this fix closes)', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
    ]);
    // 1. Operator manually expands the group before opening a reply.
    let expandedMap: Record<string, boolean> = { c1: true };
    // 2. Operator opens Reply on m1 — composerFor pins the group open.
    const composerForDuringReply = 'm1';
    expect(isGroupExpanded(group, expandedMap, composerForDuringReply)).toBe(true);

    // 3. Operator clicks the header while composing. InboxList's real
    // onToggleExpanded only mutates expandedMap when canToggleGroup allows
    // it — mirror that guard here rather than mutating unconditionally.
    const clickHeader = () => {
      if (canToggleGroup(group, composerForDuringReply)) {
        expandedMap = { ...expandedMap, [group.key]: !expandedMap[group.key] };
      }
    };
    clickHeader();
    expect(expandedMap).toEqual({ c1: true }); // unchanged — the click was suppressed, not silently applied

    // 4. Reply sends -> composerFor clears. isGroupExpanded now falls
    // through to the raw expandedMap, which still holds its PRE-PIN value
    // (true) instead of a swallowed click's stale flip.
    expect(isGroupExpanded(group, expandedMap, null)).toBe(true);
  });
});
