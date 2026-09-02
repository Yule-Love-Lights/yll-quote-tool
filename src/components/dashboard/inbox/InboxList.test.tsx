// Smoke coverage for the #252 slice D rollup — renders with react-dom/server
// (same no-jsdom approach as CustomerReferralPanel.test.tsx /
// ReferredByPicker.test.tsx). Effects (the 25s poll, the 30s clock tick)
// don't run under a static render, so this only proves the INITIAL render:
// a single-conversation contact stays a bare row, and a multi-conversation
// contact collapses into one rolled-up row instead of N separate ones. The
// grouping/sorting logic itself is covered exhaustively in
// groupInboxItems.test.ts; this just proves InboxList actually wires it in.
//
// Row 309: useRouter (next/navigation) throws outside an app-router context —
// InboxList now calls it unconditionally (React hook-order rules), so it's
// mocked here, same shape as AmendmentConsentCard.test.tsx's own mock.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }));

import { InboxList, isGroupExpanded, canToggleGroup, withRowFlagSet, withRowFlagCleared, withItemRestored, omitKey, errorNoteFor, retiresFollowUp, colorRequestConfirmMessage, replyRowAction, replyOutcomeMessage, isRefusalStatus } from './InboxList';
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

describe('InboxList customer links', () => {
  const linked = {
    ...base,
    id: 'solo',
    source: 'gmail' as const,
    contactId: 'c1',
    ghlContactId: 'hl-77',
    contact: { displayName: 'Linked Customer', email: null, phone: null },
    lastMessageAt: at(3 * 3_600_000),
  };

  it('links a row with a HighLevel id to the customer profile and to the CRM', () => {
    const html = renderToStaticMarkup(
      <InboxList initialItems={[linked]} nowMs={now} hlLocationId="loc-1" />,
    );
    expect(html).toContain('/customers/hl-77');
    expect(html).toContain('https://app.gohighlevel.com/v2/location/loc-1/contacts/detail/hl-77');
  });

  it('opens the HighLevel link in a new tab, with rel protecting the opener', () => {
    const html = renderToStaticMarkup(
      <InboxList initialItems={[linked]} nowMs={now} hlLocationId="loc-1" />,
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('renders no links at all for a contact that was never linked to HighLevel', () => {
    const unlinked = { ...linked, id: 'nolink', ghlContactId: null };
    const html = renderToStaticMarkup(
      <InboxList initialItems={[unlinked]} nowMs={now} hlLocationId="loc-1" />,
    );
    expect(html).toContain('Linked Customer');
    expect(html).not.toContain('/customers/');
    expect(html).not.toContain('app.gohighlevel.com');
  });

  it('keeps the profile link but drops the CRM link when no location id is configured', () => {
    const html = renderToStaticMarkup(<InboxList initialItems={[linked]} nowMs={now} />);
    expect(html).toContain('/customers/hl-77');
    expect(html).not.toContain('app.gohighlevel.com');
  });

  it('links the collapsed group header, whose name sits inside the expand button', () => {
    const items: OpenInboxItem[] = [
      { ...linked, id: 'g1', contactId: 'c9', ghlContactId: 'hl-88', source: 'gmail', lastMessageAt: at(3_600_000) },
      { ...linked, id: 'g2', contactId: 'c9', ghlContactId: 'hl-88', source: 'ghl', lastMessageAt: at(2 * 3_600_000) },
    ];
    const html = renderToStaticMarkup(
      <InboxList initialItems={items} nowMs={now} hlLocationId="loc-1" />,
    );
    expect(html).toContain('aria-expanded');
    expect(html).toContain('/customers/hl-88');
    // The anchor must never nest inside the expand button: an <a> inside a
    // <button> is invalid and swallows the toggle. Scoped to THAT button's
    // own inner markup on purpose. An earlier draft compared index positions
    // against the first '</button>' in the document, which is one of the
    // channel filter buttons at the top of the page, so the assertion was
    // true no matter where the link went. A mutation probe that moved the
    // link inside the button did not fail it, which is how that was caught.
    const toggleStart = html.indexOf('aria-expanded');
    const toggleEnd = html.indexOf('</button>', toggleStart);
    expect(toggleStart).toBeGreaterThan(-1);
    expect(toggleEnd).toBeGreaterThan(toggleStart);
    expect(html.slice(toggleStart, toggleEnd)).not.toContain('/customers/');
  });
});

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
// Row 291 fix: isGroupExpanded/canToggleGroup's 4th parameter changed from a
// single errorId (string | null) to errorIds, a per-item record keyed by
// item id (Record<string, boolean>) — `null` becomes `{}` (no errors) and a
// single id becomes `{ [id]: true }` below. This is purely a call-signature
// migration for the pre-existing composer-pin tests in this describe block;
// none of them concern errorId/errorIds at all (they pass an empty record
// throughout), so their assertions are unchanged.
describe('isGroupExpanded (#270 fix — composer pin)', () => {
  it('forces expanded=true when composerFor points at a member of the group, even with no expandedMap entry', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, {}, 'm1', {})).toBe(true);
  });

  it('forces expanded=true for composerFor even when the SAME group key was explicitly collapsed in expandedMap', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, { c1: false }, 'm2', {})).toBe(true);
  });

  it('falls back to the raw expandedMap value when composerFor is null and errorIds is empty', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, { c1: true }, null, {})).toBe(true);
    expect(isGroupExpanded(group, {}, null, {})).toBe(false);
  });

  it('does not force-expand a DIFFERENT group just because some other group has the open composer', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, {}, 'someone-elses-item-id', {})).toBe(false);
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
    expect(canToggleGroup(group, 'm1', {})).toBe(false);
    expect(canToggleGroup(group, 'm2', {})).toBe(false);
  });

  it('returns true when composerFor is null or points at an item outside this group', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(canToggleGroup(group, null, {})).toBe(true);
    expect(canToggleGroup(group, 'someone-elses-item-id', {})).toBe(true);
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
    expect(isGroupExpanded(group, expandedMap, composerForDuringReply, {})).toBe(true);

    // 3. Operator clicks the header while composing. InboxList's real
    // onToggleExpanded only mutates expandedMap when canToggleGroup allows
    // it — mirror that guard here rather than mutating unconditionally.
    const clickHeader = () => {
      if (canToggleGroup(group, composerForDuringReply, {})) {
        expandedMap = { ...expandedMap, [group.key]: !expandedMap[group.key] };
      }
    };
    clickHeader();
    expect(expandedMap).toEqual({ c1: true }); // unchanged — the click was suppressed, not silently applied

    // 4. Reply sends -> composerFor clears. isGroupExpanded now falls
    // through to the raw expandedMap, which still holds its PRE-PIN value
    // (true) instead of a swallowed click's stale flip.
    expect(isGroupExpanded(group, expandedMap, null, {})).toBe(true);
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
//
// Row 291 fix: errorId (a single id) is now errorIds (a per-item record) —
// `'m2'` becomes `{ m2: true }` below.
describe('isGroupExpanded (#289 fix round 2 — also force-open on errorIds)', () => {
  it('forces expanded=true when errorIds names a member, even when the SAME group key was explicitly collapsed in expandedMap', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, { c1: false }, null, { m2: true })).toBe(true);
  });

  it('forces expanded=true for a group with NO expandedMap entry at all — the newly-multi case: a poll adds a sibling to a contact whose earlier action just failed', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, {}, null, { m1: true })).toBe(true);
  });

  it('does not force-expand a DIFFERENT group just because some other group has the errored member', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(isGroupExpanded(group, {}, null, { 'someone-elses-item-id': true })).toBe(false);
  });

  // Row 291 fix, new: TWO different groups can each have their own errored
  // member in errorIds SIMULTANEOUSLY (the whole point of the per-item
  // record) — each group's force-open decision reads only ITS OWN members,
  // so neither group's pin is affected by the other's entry.
  it('force-opens each of two DIFFERENT groups independently when errorIds names a member of each at once', () => {
    const groupA = makeGroup([
      { ...base, id: 'aMember', contactId: 'cA', lastMessageAt: at(1 * 3_600_000) },
    ]);
    const groupB = makeGroup([
      { ...base, id: 'bMember', contactId: 'cB', lastMessageAt: at(1 * 3_600_000) },
    ]);
    const errorIds = { aMember: true, bMember: true };
    expect(isGroupExpanded(groupA, {}, null, errorIds)).toBe(true);
    expect(isGroupExpanded(groupB, {}, null, errorIds)).toBe(true);
  });
});

// #289 fix, corrected in round 2 (staff MED, cross-wave #769x#776
// composition): round 1 also pinned on busyId — removed as a dead
// parameter (see canToggleGroup's own doc comment in InboxList.tsx for the
// reachability proof: act() removes a busy item from `items` in the SAME
// batched render that sets busyId, so a busy item can never be a
// group.members entry when this function runs). errorIds is the only real
// pin here now, alongside composerFor.
//
// Row 291 fix: errorId (a single id) is now errorIds (a per-item record) —
// `'m1'` becomes `{ m1: true }` below.
describe('canToggleGroup (#289 fix round 2 — errorIds pin only; busyId removed as unreachable)', () => {
  it('returns false while errorIds names a member of the group', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
    ]);
    expect(canToggleGroup(group, null, { m1: true })).toBe(false);
    expect(canToggleGroup(group, null, { m2: true })).toBe(false);
  });

  it('returns true again once errorIds no longer names any member — collapsible', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(canToggleGroup(group, null, {})).toBe(true);
  });

  it('returns true when errorIds names an item OUTSIDE this group — a sibling group erroring elsewhere in the inbox must never pin this one', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    expect(canToggleGroup(group, null, { 'some-other-groups-item': true })).toBe(true);
  });

  it('composerFor pinning is unchanged by the round-2 signature change', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
    ]);
    expect(canToggleGroup(group, 'm1', {})).toBe(false);
    expect(canToggleGroup(group, null, {})).toBe(true);
  });

  // THE EXACT round-1 lockout this round fixes (finding 2 in the review):
  // an already-expanded, 3+-member group where one member goes busy (and is
  // therefore ABSENT from group.members — see canToggleGroup's doc comment)
  // can still be collapsed, because nothing pins it during the busy window.
  // If that action then fails, errorIds names the now-restored member of a
  // COLLAPSED group — round 1 would have blocked the toggle (correct) but
  // never forced the display back open (the bug), stranding it hidden with
  // its own re-open control disabled. Round 2's isGroupExpanded errorIds pin
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
    // removes m1 from `items` in the same batch as setBusyIds, so the very
    // next render's group has only m2/m3 (modeled directly here, matching
    // production's real per-render recompute).
    const whileM1Busy = makeGroup([
      { ...base, id: 'm2', contactId: 'c1', lastMessageAt: at(2 * 3_600_000) },
      { ...base, id: 'm3', contactId: 'c1', lastMessageAt: at(3 * 3_600_000) },
    ]);
    let expandedMap: Record<string, boolean> = { c1: true };
    expect(canToggleGroup(whileM1Busy, null, {})).toBe(true); // nothing blocks the collapse
    expandedMap = { ...expandedMap, c1: false }; // operator collapses it

    // 2. m1's action fails. errorIds gets m1 set and refresh() restores m1 —
    // group is back to all 3 members, with errorIds naming one of them.
    const errorIds = { m1: true };
    expect(isGroupExpanded(allThree, expandedMap, null, errorIds)).toBe(true); // forced back open...
    expect(canToggleGroup(allThree, null, errorIds)).toBe(false); // ...and can't be re-collapsed while it stands

    // 3. Operator resolves it (retries m1 successfully) — errorIds clears
    // back to empty (mirroring withRowFlagCleared, exercised directly below).
    // isGroupExpanded falls back to expandedMap, which still holds the
    // operator's OWN earlier collapse choice — not a swallowed click's
    // stale flip, because nothing needed to suppress that click in step 1
    // (there was nothing to hide while m1 was merely busy and absent).
    expect(isGroupExpanded(allThree, expandedMap, null, {})).toBe(false);
    expect(canToggleGroup(allThree, null, {})).toBe(true);
  });

  // Row 291 fix, new: the group force-open/lock behavior survives an
  // UNRELATED row's action elsewhere in the inbox. Before the fix, act() on
  // any row cleared the single global errorId slot — which would have wiped
  // THIS group's pin even though none of its own members were touched.
  // withRowFlagCleared is the exact primitive act() calls on its own row id;
  // using it here (rather than hand-rolling the same delete) proves the
  // real production transition, not a re-implementation of it.
  it('an unrelated row resolving its own error (withRowFlagCleared on a DIFFERENT id) leaves this group force-open, because its own member key is untouched', () => {
    const group = makeGroup([
      { ...base, id: 'm1', contactId: 'c1', lastMessageAt: at(1 * 3_600_000) },
    ]);
    let errorIds: Record<string, boolean> = { m1: true, 'unrelated-row': true };
    expect(isGroupExpanded(group, {}, null, errorIds)).toBe(true);

    // Some OTHER row's act() call succeeds and clears its own key.
    errorIds = withRowFlagCleared(errorIds, 'unrelated-row');
    expect(errorIds).toEqual({ m1: true }); // m1's entry is untouched
    expect(isGroupExpanded(group, {}, null, errorIds)).toBe(true); // still forced open
    expect(canToggleGroup(group, null, errorIds)).toBe(false); // still can't collapse
  });
});

// Row 291 fix: withRowFlagSet/withRowFlagCleared are the exact pure
// primitives act() and dismissError call to read/write the per-item
// busyIds/errorIds maps — see their own doc comment in InboxList.tsx. These
// tests pin the ledger-291 bug directly at the level of that shared logic:
// no jsdom or fetch mock needed, because the whole defect was in the STATE
// SHAPE (a single global slot), not in any render or network code the repo's
// static-render harness can't drive. ItemRow's own read of the map
// (`errorIds[item.id]`, `busyIds[item.id]`) is a one-line lookup with no
// branching to test independently — its correctness follows directly from
// the map holding the right keys, which is what's pinned here.
describe('withRowFlagSet / withRowFlagCleared (row 291 — per-item busy/error maps)', () => {
  it('setting the flag for two different row ids leaves both present simultaneously — the fix for "only one row can show an error at a time"', () => {
    let errorIds: Record<string, boolean> = {};
    errorIds = withRowFlagSet(errorIds, 'rowA');
    errorIds = withRowFlagSet(errorIds, 'rowB');
    // Both rows' error notes render off this same map (errorIds[item.id]),
    // so both being present here is exactly "both notes visible at once".
    expect(errorIds).toEqual({ rowA: true, rowB: true });
  });

  it('helper: the clear act() runs for row B on entry leaves row A\'s entry untouched', () => {
    const bothErrored: Record<string, boolean> = { rowA: true, rowB: true };
    // This is exactly what act(id='rowB', ...) does at its own start.
    const afterActingOnRowB = withRowFlagCleared(bothErrored, 'rowB');
    expect(afterActingOnRowB).toEqual({ rowA: true }); // rowA survives untouched
  });

  it('helper: the clear dismissError runs for row A leaves row B\'s entry intact', () => {
    const bothErrored: Record<string, boolean> = { rowA: true, rowB: true };
    // This is exactly what dismissError('rowA') does.
    const afterDismissingRowA = withRowFlagCleared(bothErrored, 'rowA');
    expect(afterDismissingRowA).toEqual({ rowB: true }); // rowB survives untouched
  });

  it('helper: set/clear on one busy id never adds or removes another id\'s entry', () => {
    let busyIds: Record<string, boolean> = {};
    busyIds = withRowFlagSet(busyIds, 'rowA'); // rowA starts an action
    busyIds = withRowFlagSet(busyIds, 'rowB'); // rowB starts a different action
    expect(busyIds).toEqual({ rowA: true, rowB: true }); // both independently busy
    busyIds = withRowFlagCleared(busyIds, 'rowA'); // rowA's action finishes (the `finally` clause)
    expect(busyIds).toEqual({ rowB: true }); // rowB is still busy/disabled; rowA is not
  });

  it('clearing a flag for an id that was never set is a no-op that returns the SAME object reference (skips an unnecessary state update)', () => {
    const errorIds: Record<string, boolean> = { rowA: true };
    expect(withRowFlagCleared(errorIds, 'rowB')).toBe(errorIds);
  });

  it('setting a flag for a new id preserves an existing map\'s other entries', () => {
    const map: Record<string, boolean> = { rowA: true, rowC: true };
    expect(withRowFlagSet(map, 'rowB')).toEqual({ rowA: true, rowB: true, rowC: true });
  });
});

// #302 fix: withItemRestored is the exact pure primitive act()'s catch block
// (a thrown fetch — network down, DNS failure, a dropped connection) calls to
// put a row back after the optimistic removal, mirroring withRowFlagSet's own
// call in that same catch. Pinned directly, no jsdom/fetch mock needed, for
// the same reason the busy/error map helpers above are: the defect (and the
// fix) lives entirely in this state-shape logic, not in any render or network
// code the repo's static-render harness can't drive. What this does NOT (and
// cannot, without jsdom) prove: that InboxList actually renders the restored
// row's "Something went wrong" note and Dismiss control on screen — that's
// asserted by reading the render path in the source (ItemRow's
// `errorIds[item.id]` check, fed by `groups` <- `visibleItems` <- `items`),
// not by a test here.
describe('withItemRestored (#302 — restore an optimistically-removed row after a thrown fetch)', () => {
  const solo: OpenInboxItem = { ...base, id: 'x', contactId: 'c1', contact: { displayName: 'Restored Customer', email: null, phone: null } };

  it('restores a row that is absent from items — the fix for a thrown fetch otherwise leaving the row (and its error note) gone for good', () => {
    expect(withItemRestored([], 'x', solo)).toEqual([solo]);
  });

  it('preserves the other rows already in items when restoring one', () => {
    const other: OpenInboxItem = { ...base, id: 'other', contactId: 'c2' };
    expect(withItemRestored([other], 'x', solo)).toEqual([other, solo]);
  });

  it('does not duplicate a row a concurrent refresh() already restored — an id already present in items always wins over the stale pre-removal snapshot', () => {
    const fresher: OpenInboxItem = { ...base, id: 'x', contactId: 'c1', escalationLevel: 2 }; // e.g. escalated by the poll in the meantime
    const items = [fresher];
    const result = withItemRestored(items, 'x', solo);
    expect(result).toBe(items); // same reference — no-op, and definitely not solo's stale copy
    expect(result).toEqual([fresher]);
  });

  it('is a no-op (same reference) when there is no snapshot to restore — removedItem undefined (e.g. the id was already absent when act() captured it)', () => {
    const items: OpenInboxItem[] = [];
    expect(withItemRestored(items, 'x', undefined)).toBe(items);
  });

  it('mirrors act()\'s actual catch block: a thrown fetch leaves the row present (restored) AND flagged errored, combining this fix with row 291\'s per-item errorIds', () => {
    let items: OpenInboxItem[] = []; // state right after act()'s optimistic removal
    let errorIds: Record<string, boolean> = {};
    // These two lines are exactly act()'s catch body.
    errorIds = withRowFlagSet(errorIds, solo.id);
    items = withItemRestored(items, solo.id, solo);
    expect(items).toEqual([solo]);
    expect(errorIds).toEqual({ x: true });
  });
});

// #302 review (customer lens): after a THROWN fetch the write may already have
// committed, so the row's real status is unknown. Leaving every OTHER action
// enabled is not harmless — dismissItem's guard is `.neq('status','dismissed')`,
// so on a row that is really already 'handled' a "Not a lead" click passes the
// guard, flips an answered lead to dismissed, and suppresses that customer's
// future messages. unreachableActions records WHICH action was attempted so the
// row can be locked to retrying that one; omitKey is how that record is cleared.
describe('omitKey (#302 — clearing the recorded unreachable action)', () => {
  it('removes only the named key', () => {
    expect(omitKey({ a: 'Handled', b: 'Followed' }, 'a')).toEqual({ b: 'Followed' });
  });

  it('returns the SAME reference when the key is absent, so an unaffected row does not re-render', () => {
    const map = { a: 'Handled' };
    expect(omitKey(map, 'missing')).toBe(map);
  });

  it('does not mutate the input map', () => {
    const map = { a: 'Handled', b: 'Followed' };
    omitKey(map, 'a');
    expect(map).toEqual({ a: 'Handled', b: 'Followed' });
  });

  it('leaves an empty map alone, same reference', () => {
    const map: Record<string, string> = {};
    expect(omitKey(map, 'a')).toBe(map);
  });
});

// The lock predicate as ItemRow computes it: `lockedTo` is the recorded action
// for THIS row (or null), and every other action is disabled while it stands.
describe('the unreachable-action lock (#302)', () => {
  const lockedOut = (lockedTo: string | null, label: string) => lockedTo !== null && lockedTo !== label;

  it('locks the three actions that were not attempted', () => {
    expect(lockedOut('Handled', 'Not a lead')).toBe(true);
    expect(lockedOut('Handled', 'Followed')).toBe(true);
    expect(lockedOut('Handled', 'Mark completed')).toBe(true);
  });

  it('leaves the attempted action clickable so the operator can retry it', () => {
    expect(lockedOut('Handled', 'Handled')).toBe(false);
  });

  it('locks nothing when no unreachable action is recorded for the row', () => {
    for (const label of ['Handled', 'Not a lead', 'Followed', 'Mark completed']) {
      expect(lockedOut(null, label)).toBe(false);
    }
  });
});

// Row 311 fix-round FIX 3: before this, a definite server rejection's own
// `data.error` was discarded — only the generic "Something went wrong" note
// ever rendered. errorNoteFor picks the right text; the thrown-fetch case
// (unreachableAction set) is unchanged.
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

// Row 392: isRefusalStatus is the exact gate act() uses to tell a CAS refusal
// (the row genuinely moved out from under it — dismiss/route.ts's own 409)
// apart from a plain backend failure (503) or a network throw, which is what
// decides whether act() restores the row + refusedIds it (this row's note
// must survive) versus falling through to the old refresh()-only path.
describe('isRefusalStatus (row 392 — distinguishing a CAS refusal from a backend failure)', () => {
  it('409 is a refusal', () => {
    expect(isRefusalStatus(409)).toBe(true);
  });

  it('503 is not a refusal — the item is unchanged server-side, refresh() already handles it', () => {
    expect(isRefusalStatus(503)).toBe(false);
  });

  it('200/404/500 are not refusals either', () => {
    expect(isRefusalStatus(200)).toBe(false);
    expect(isRefusalStatus(404)).toBe(false);
    expect(isRefusalStatus(500)).toBe(false);
  });
});

// Row 321: badges an isColorRequest row so it's visually distinct before
// Handled/Mark completed can silently bury a still-pending colour request.
// The click-then-confirm-then-act flow itself can't be driven without jsdom
// (same limitation as the rest of this file — see the header comment); the
// message the confirm gate shows is pinned directly below.
describe('InboxList (row 321 — pending colour request badge)', () => {
  it('badges a row flagged isColorRequest with "Colour request pending"', () => {
    const items: OpenInboxItem[] = [
      { ...base, id: 'cr1', source: 'quotetool', contactId: 'c1', contact: { displayName: 'Colour Customer', email: null, phone: null }, isColorRequest: true, lastMessageAt: at(3_600_000) },
    ];
    const html = renderToStaticMarkup(<InboxList initialItems={items} nowMs={now} />);
    expect(html).toContain('Colour Customer');
    expect(html).toContain('Colour request pending');
  });

  it('does not badge an ordinary row', () => {
    const items: OpenInboxItem[] = [
      { ...base, id: 'ord1', source: 'ghl', contactId: 'c2', contact: { displayName: 'Ordinary Customer', email: null, phone: null }, lastMessageAt: at(3_600_000) },
    ];
    const html = renderToStaticMarkup(<InboxList initialItems={items} nowMs={now} />);
    expect(html).toContain('Ordinary Customer');
    expect(html).not.toContain('Colour request pending');
  });
});

describe('colorRequestConfirmMessage (row 321 — pure)', () => {
  it('names what is outstanding and points to the quote admin page', () => {
    const msg = colorRequestConfirmMessage();
    expect(msg).toContain('This customer is waiting on a colour change — mark it handled anyway?');
    // Row 321 fix-round FIX 3: names the REAL on-page heading
    // (ColorRequestPanel.tsx's pre-apply h2), never the nonexistent
    // "Colour request panel" label the original copy invented.
    expect(msg).toContain('Colour change requested');
    expect(msg).not.toContain('Colour request panel');
  });
});

// Row 309: act()'s router.refresh() re-renders the whole InboxPage server
// component, so it is gated on the actions that actually move a follow-up
// rather than firing after every successful action.
// PR #1005: 'Followed' JOINED that set — markItemFollowed now closes the item's
// quote_sent_no_reply nag itself, and the awaiting bucket's "N follow-ups due"
// count is server-rendered, so it needs the refresh to stay honest.
describe('retiresFollowUp (rows 309/430 — which actions can retire a due follow-up)', () => {
  it('is true for dismiss and completed — the two terminal transitions', () => {
    expect(retiresFollowUp('/api/dashboard/dismiss')).toBe(true);
    expect(retiresFollowUp('/api/dashboard/completed')).toBe(true);
  });

  it('is true for followed — PR #1005 made it close the nag', () => {
    expect(retiresFollowUp('/api/dashboard/followed')).toBe(true);
  });

  it('is false for handled — it retires nothing', () => {
    expect(retiresFollowUp('/api/dashboard/handled')).toBe(false);
  });
});

// Fix round 3 (MED): this file was the THIRD, unaudited ReplyComposer
// consumer — onComposerSent ignored the outcome entirely and removed the row
// on ANY send, including 'error', where the write's outcome is unconfirmed
// and the item is most likely still genuinely 'unresponded'. Pure-function
// coverage of the DECISION, mirroring InWorksSection.test.tsx's identical
// coverage of its own copy — the useState wiring itself stays untested (no
// jsdom in this repo, same constraint as every other stateful branch here).
describe('replyRowAction (fix round 3 — what a reply outcome does to the row)', () => {
  it('resolved leaves the open queue immediately — the item is no longer unresponded', () => {
    expect(replyRowAction('resolved')).toBe('move');
  });

  it('refused (a genuine CAS refusal) flags AND removes the row — but only once dismissed, never synchronously', () => {
    expect(replyRowAction('refused')).toBe('flag-and-remove');
  });

  it('error (an unknown failure, not a refusal) flags the row but KEEPS it — removing would hide a still-open lead from the primary open queue', () => {
    expect(replyRowAction('error')).toBe('flag-and-keep');
  });
});

describe('replyOutcomeMessage (fix round 3 — worded identically to InWorksSection.tsx)', () => {
  it('refused reads as a settled fact: the item really was resolved elsewhere', () => {
    const msg = replyOutcomeMessage('refused').toLowerCase();
    expect(msg).toContain('already resolved');
    expect(msg).not.toContain("couldn't confirm");
  });

  it('error reads as a genuine unknown, not a confirmed resolution — must not claim the item was resolved', () => {
    const msg = replyOutcomeMessage('error').toLowerCase();
    expect(msg).toContain("couldn't confirm");
    expect(msg).not.toContain('already resolved');
  });

  it('the two messages are different strings — a staffer must not see the same note for both', () => {
    expect(replyOutcomeMessage('refused')).not.toBe(replyOutcomeMessage('error'));
  });
});
