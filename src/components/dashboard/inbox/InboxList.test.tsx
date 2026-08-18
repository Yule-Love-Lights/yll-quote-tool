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
    expect(isGroupExpanded(group, {}, 'm1', null)).toBe(true);
  });

  it('forces expanded=true for composerFor even when the SAME group key was explicitly collapsed in expandedMap', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, { c1: false }, 'm2', null)).toBe(true);
  });

  it('falls back to the raw expandedMap value when composerFor and errorId are both null', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, { c1: true }, null, null)).toBe(true);
    expect(isGroupExpanded(group, {}, null, null)).toBe(false);
  });

  it('does not force-expand a DIFFERENT group just because some other group has the open composer', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, {}, 'someone-elses-item-id', null)).toBe(false);
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
    expect(canToggleGroup(group, 'm1', null)).toBe(false);
    expect(canToggleGroup(group, 'm2', null)).toBe(false);
  });

  it('returns true when composerFor is null or points at an item outside this group', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(canToggleGroup(group, null, null)).toBe(true);
    expect(canToggleGroup(group, 'someone-elses-item-id', null)).toBe(true);
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
    expect(isGroupExpanded(group, expandedMap, composerForDuringReply, null)).toBe(true);

    // 3. Operator clicks the header while composing. InboxList's real
    // onToggleExpanded only mutates expandedMap when canToggleGroup allows
    // it — mirror that guard here rather than mutating unconditionally.
    const clickHeader = () => {
      if (canToggleGroup(group, composerForDuringReply, null)) {
        expandedMap = { ...expandedMap, [group.key]: !expandedMap[group.key] };
      }
    };
    clickHeader();
    expect(expandedMap).toEqual({ c1: true }); // unchanged — the click was suppressed, not silently applied

    // 4. Reply sends -> composerFor clears. isGroupExpanded now falls
    // through to the raw expandedMap, which still holds its PRE-PIN value
    // (true) instead of a swallowed click's stale flip.
    expect(isGroupExpanded(group, expandedMap, null, null)).toBe(true);
  });
});

// #289 fix round 2 (HIGH, delta-verify on round 1's own MED fix — three
// review lenses independently converged): round 1 taught canToggleGroup to
// block collapsing while errorId names a member, but never taught THIS
// function to force the group open the way it already does for composerFor
// — so a group already collapsed when its member's action failed (or one
// turning multi for the FIRST time with an already-errored member) rendered
// collapsed AND had its header disabled by canToggleGroup's own new guard,
// with nothing left to re-open it. See canToggleGroup's own doc comment in
// InboxList.tsx for the full trace, and the round-1-lockout test in the
// describe block below for the exact end-to-end sequence.
describe('isGroupExpanded (#289 fix round 2 — also force-open on errorId)', () => {
  it('forces expanded=true when errorId names a member, even when the SAME group key was explicitly collapsed in expandedMap', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, { c1: false }, null, 'm2')).toBe(true);
  });

  it('forces expanded=true for a group with NO expandedMap entry at all — the newly-multi case: a poll adds a sibling to a contact whose earlier action just failed', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, {}, null, 'm1')).toBe(true);
  });

  it('does not force-expand a DIFFERENT group just because some other group has the errored member', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, {}, null, 'someone-elses-item-id')).toBe(false);
  });
});

// #289 fix, corrected in round 2 (staff MED, cross-wave #769x#776
// composition): round 1 also pinned on busyId — removed as a dead
// parameter (see canToggleGroup's own doc comment in InboxList.tsx for the
// reachability proof: act() removes a busy item from `items` in the SAME
// batched render that sets busyId, so a busy item can never be a
// group.members entry when this function runs). errorId is the only real
// pin here now, alongside composerFor.
describe('canToggleGroup (#289 fix round 2 — errorId pin only; busyId removed as unreachable)', () => {
  it('returns false while errorId names a member of the group', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
    ]);
    expect(canToggleGroup(group, null, 'm1')).toBe(false);
    expect(canToggleGroup(group, null, 'm2')).toBe(false);
  });

  it('returns true again once errorId clears back to null — collapsible', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(canToggleGroup(group, null, null)).toBe(true);
  });

  it('returns true when errorId names an item OUTSIDE this group — a sibling group erroring elsewhere in the inbox must never pin this one', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(canToggleGroup(group, null, 'some-other-groups-item')).toBe(true);
  });

  it('composerFor pinning is unchanged by the round-2 signature change', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
    ]);
    expect(canToggleGroup(group, 'm1', null)).toBe(false);
    expect(canToggleGroup(group, null, null)).toBe(true);
  });

  // THE EXACT round-1 lockout this round fixes (finding 2 in the review):
  // an already-expanded, 3+-member group where one member goes busy (and is
  // therefore ABSENT from group.members — see canToggleGroup's doc comment)
  // can still be collapsed, because nothing pins it during the busy window.
  // If that action then fails, errorId names the now-restored member of a
  // COLLAPSED group — round 1 would have blocked the toggle (correct) but
  // never forced the display back open (the bug), stranding it hidden with
  // its own re-open control disabled. Round 2's isGroupExpanded errorId pin
  // (see that describe block above) closes the display half; this proves
  // both halves together, plus the release back to the operator's own
  // pre-error collapse choice once the error clears.
  it('the exact round-1 lockout sequence: a group collapsed while its member is busy force-re-expands (and stays un-collapsible) once that action fails, then falls back to whatever the operator had already chosen once resolved', () => {
    const allThree = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
      { ...base, id: 'm3', contactId: 'c1', lastMessageAt: at(3 * 3_600_000) },
    ]);
    // 1. Group starts expanded. Operator clicks an action on m1 — act()
    // removes m1 from `items` in the same batch as setBusyId, so the very
    // next render's group has only m2/m3 (modeled directly here, matching
    // production's real per-render recompute).
    const whileM1Busy = makeGroup([
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
      { ...base, id: 'm3', contactId: 'c1', lastMessageAt: at(3 * 3_600_000) },
    ]);
    let expandedMap: Record<string, boolean> = { c1: true };
    expect(canToggleGroup(whileM1Busy, null, null)).toBe(true); // nothing blocks the collapse
    expandedMap = { ...expandedMap, c1: false }; // operator collapses it

    // 2. m1's action fails. errorId is set and refresh() restores m1 —
    // group is back to all 3 members, with errorId naming one of them.
    const errorId = 'm1';
    expect(isGroupExpanded(allThree, expandedMap, null, errorId)).toBe(true); // forced back open...
    expect(canToggleGroup(allThree, null, errorId)).toBe(false); // ...and can't be re-collapsed while it stands

    // 3. Operator resolves it (retries m1 successfully) — errorId clears.
    // isGroupExpanded falls back to expandedMap, which still holds the
    // operator's OWN earlier collapse choice — not a swallowed click's
    // stale flip, because nothing needed to suppress that click in step 1
    // (there was nothing to hide while m1 was merely busy and absent).
    expect(isGroupExpanded(allThree, expandedMap, null, null)).toBe(false);
    expect(canToggleGroup(allThree, null, null)).toBe(true);
  });
});
