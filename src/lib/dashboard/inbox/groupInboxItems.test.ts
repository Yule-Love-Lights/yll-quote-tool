import { describe, it, expect } from 'vitest';
import { groupInboxItems } from './groupInboxItems';
import type { OpenInboxItem } from './types';

const base: OpenInboxItem = {
  id: 'x', source: 'ghl', channel: null, direction: null, lastMessageAt: null, preview: null,
  subject: null, escalationLevel: 0, leadKind: 'lead', quoteValue: null, isReturning: false,
  contactId: null, assignedTo: null, contact: null,
};
const at = (msAgo: number, now: number) => new Date(now - msAgo).toISOString();
const now = 1_000_000_000_000;

describe('groupInboxItems', () => {
  it('groups items sharing a contactId into one entry', () => {
    const items: OpenInboxItem[] = [
      { ...base, id: 'a', source: 'gmail', contactId: 'c1', lastMessageAt: at(3 * 3_600_000, now) },
      { ...base, id: 'b', source: 'ghl', contactId: 'c1', lastMessageAt: at(1 * 3_600_000, now) },
    ];
    const groups = groupInboxItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].contactId).toBe('c1');
    expect(groups[0].members.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it('never merges two null-contactId items into the same group', () => {
    const items: OpenInboxItem[] = [
      { ...base, id: 'a', contactId: null, lastMessageAt: at(3 * 3_600_000, now) },
      { ...base, id: 'b', contactId: null, lastMessageAt: at(1 * 3_600_000, now) },
    ];
    const groups = groupInboxItems(items);
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.members.length === 1)).toBe(true);
    expect(groups.map((g) => g.contactId)).toEqual([null, null]);
  });

  it('picks the OLDEST member as primary and NEWEST as `newest`, independent of input order', () => {
    // Deliberately fed newest-first (opposite of listOpenItems' real order) to
    // prove this doesn't just trust caller order.
    const items: OpenInboxItem[] = [
      { ...base, id: 'newest-in', source: 'gmail', contactId: 'c1', preview: 'latest text', lastMessageAt: at(1 * 3_600_000, now) },
      { ...base, id: 'middle', source: 'ghl', contactId: 'c1', lastMessageAt: at(2 * 3_600_000, now) },
      { ...base, id: 'oldest-in', source: 'quotetool', contactId: 'c1', escalationLevel: 2, lastMessageAt: at(5 * 3_600_000, now) },
    ];
    const groups = groupInboxItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].primary.id).toBe('oldest-in');
    expect(groups[0].primary.escalationLevel).toBe(2);
    expect(groups[0].newest.id).toBe('newest-in');
    expect(groups[0].newest.preview).toBe('latest text');
    // members themselves come back oldest-first too.
    expect(groups[0].members.map((m) => m.id)).toEqual(['oldest-in', 'middle', 'newest-in']);
  });

  it('sorts the GROUPS array by each group\'s oldest member, so an older thread never gets buried under a fresher sibling', () => {
    const items: OpenInboxItem[] = [
      // Contact A's only touch is recent (2h).
      { ...base, id: 'a1', contactId: 'A', lastMessageAt: at(2 * 3_600_000, now) },
      // Contact B has an old thread (6h) plus a fresh one (30m) — B's GROUP
      // must still sort ahead of A because its oldest member (6h) is older.
      { ...base, id: 'b-old', contactId: 'B', lastMessageAt: at(6 * 3_600_000, now) },
      { ...base, id: 'b-new', contactId: 'B', lastMessageAt: at(30 * 60_000, now) },
    ];
    const groups = groupInboxItems(items);
    expect(groups.map((g) => g.contactId)).toEqual(['B', 'A']);
  });

  it('counts members per source (not per channel)', () => {
    const items: OpenInboxItem[] = [
      { ...base, id: 'a', source: 'gmail', contactId: 'c1', lastMessageAt: at(3 * 3_600_000, now) },
      { ...base, id: 'b', source: 'gmail', contactId: 'c1', lastMessageAt: at(2 * 3_600_000, now) },
      { ...base, id: 'c', source: 'ghl', contactId: 'c1', lastMessageAt: at(1 * 3_600_000, now) },
    ];
    const groups = groupInboxItems(items);
    expect(groups[0].sourceCounts).toEqual({ gmail: 2, ghl: 1 });
  });

  it('a group with zero surviving members after a caller-side filter simply never appears (filter-empties-group)', () => {
    const items: OpenInboxItem[] = [
      { ...base, id: 'a', source: 'gmail', contactId: 'c1', lastMessageAt: at(3 * 3_600_000, now) },
      { ...base, id: 'b', source: 'ghl', contactId: 'c2', lastMessageAt: at(1 * 3_600_000, now) },
    ];
    // Mirrors InboxList's own "filter the flat array first, then group what
    // survives" pattern — a channel filter that drops c1's only item entirely.
    const filtered = items.filter((i) => i.source === 'ghl');
    const groups = groupInboxItems(filtered);
    expect(groups.map((g) => g.contactId)).toEqual(['c2']);
  });

  it('a single-conversation contact passes through as a 1-member group (primary === newest === the only item)', () => {
    const items: OpenInboxItem[] = [
      { ...base, id: 'solo', source: 'quotetool', contactId: 'c9', preview: 'just one', lastMessageAt: at(3 * 3_600_000, now) },
    ];
    const groups = groupInboxItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(1);
    expect(groups[0].primary).toBe(groups[0].members[0]);
    expect(groups[0].newest).toBe(groups[0].members[0]);
    expect(groups[0].primary.id).toBe('solo');
  });

  it('treats a null lastMessageAt as sorting last (unknown age never jumps the queue)', () => {
    const items: OpenInboxItem[] = [
      { ...base, id: 'unknown-age', contactId: 'c1', lastMessageAt: null },
      { ...base, id: 'known-age', contactId: 'c1', lastMessageAt: at(1 * 3_600_000, now) },
    ];
    const groups = groupInboxItems(items);
    expect(groups[0].primary.id).toBe('known-age');
    expect(groups[0].newest.id).toBe('unknown-age');
  });

  // #270 fix round (technical LOW): lock in the branches the suite relied on
  // but never actually exercised.

  it('returns an empty array for empty input', () => {
    expect(groupInboxItems([])).toEqual([]);
  });

  it('preserves input order for two null-lastMessageAt members in ONE group (the Infinity - Infinity = NaN comparator path)', () => {
    // time(null) = Infinity for both, so byOldestFirst returns NaN. Per spec
    // (CompareArrayElements: "If v is NaN, return +0") a NaN comparator
    // result is normalized to 0, and Array.prototype.sort is stable (ES2019+)
    // — so the two members keep their INPUT order rather than either
    // arbitrarily winning.
    const items: OpenInboxItem[] = [
      { ...base, id: 'first-in', contactId: 'c1', lastMessageAt: null },
      { ...base, id: 'second-in', contactId: 'c1', lastMessageAt: null },
    ];
    const groups = groupInboxItems(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.id)).toEqual(['first-in', 'second-in']);
  });

  it('preserves first-occurrence order for two GROUPS whose primaries are both null-lastMessageAt', () => {
    // Same NaN->0 stable-sort path, but at the groups.sort() level: neither
    // group's primary has a real timestamp to compare, so the groups array
    // keeps the order the Map first saw each contactId in.
    const items: OpenInboxItem[] = [
      { ...base, id: 'a', contactId: 'G1', lastMessageAt: null },
      { ...base, id: 'b', contactId: 'G2', lastMessageAt: null },
    ];
    const groups = groupInboxItems(items);
    expect(groups.map((g) => g.contactId)).toEqual(['G1', 'G2']);
  });

  it('preserves input order for two members with the exact same non-null timestamp', () => {
    const tie = at(2 * 3_600_000, now);
    const items: OpenInboxItem[] = [
      { ...base, id: 'first-in', contactId: 'c1', lastMessageAt: tie },
      { ...base, id: 'second-in', contactId: 'c1', lastMessageAt: tie },
    ];
    const groups = groupInboxItems(items);
    expect(groups[0].members.map((m) => m.id)).toEqual(['first-in', 'second-in']);
  });
});
