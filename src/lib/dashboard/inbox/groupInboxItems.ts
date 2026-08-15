// Pure client-side rollup for the /inbox list (#252 slice D). Groups the
// already-fetched OpenInboxItem[] by contactId so a customer who reached out
// via email AND text AND has a quote shows as ONE visual row (expandable),
// instead of one row per source/conversation. Row IDENTITY in the data model
// stays one-row-per-conversation-per-source (by design, unchanged, per row
// 252) — this is purely a display-layer fold over whatever's already been
// fetched (and, in InboxList, already channel/automated-filtered), so the
// channel filter composes for free: filter the flat array first, group what
// survives, and a contact with zero surviving members never gets a group.
//
// Sort-independent by design: does NOT trust the caller's array order, even
// though listOpenItems() already returns oldest-first (store.ts, `.order(
// 'last_message_at', { ascending: true })`). Re-deriving oldest/newest from
// parsed timestamps here means this helper is correct for any input order,
// and its own tests exercise real sort logic instead of merely proving
// "preserved whatever order the caller happened to pass in."

import type { OpenInboxItem, InboxSource } from './types';

export type InboxGroup = {
  /** contactId when present; a synthetic per-item key when not, so two
   *  unlinked (contactId: null) items never collide into the same group. */
  key: string;
  contactId: string | null;
  /** All members, oldest-first (same ordering convention as listOpenItems). */
  members: OpenInboxItem[];
  /** Oldest member (members[0] post-sort) — the one waiting longest. Drives
   *  the group row's displayed name/escalation dot/age: the flat list is
   *  oldest-first for a reason (nothing should get buried by a newer
   *  sibling), so the group inherits its oldest member's urgency. */
  primary: OpenInboxItem;
  /** Newest member (last post-sort) — drives the group row's preview line,
   *  so the collapsed row shows the latest thing the customer said. */
  newest: OpenInboxItem;
  /** Member count per source (e.g. { gmail: 2, ghl: 1 }) for the group row's
   *  badge summary. Keyed on `source` (ghl/gmail/quotetool/homeworks), not
   *  `channel` (sms/email/...) — matches the row-identity model ("one row
   *  per conversation per source") and the existing per-row SOURCE_LABEL
   *  badge in InboxList.tsx; the brief's "email x2 . text x1" phrasing was
   *  illustrative, not a literal field name. */
  sourceCounts: Partial<Record<InboxSource, number>>;
};

/** Null lastMessageAt sorts LAST in ascending order — mirrors Postgres's own
 *  default (NULLS LAST on ASC), which is what listOpenItems' query already
 *  produces, so a row of unknown age doesn't jump ahead of real waiting
 *  customers. */
function time(iso: string | null): number {
  return iso ? new Date(iso).getTime() : Number.POSITIVE_INFINITY;
}

function byOldestFirst(a: OpenInboxItem, b: OpenInboxItem): number {
  return time(a.lastMessageAt) - time(b.lastMessageAt);
}

export function groupInboxItems(items: OpenInboxItem[]): InboxGroup[] {
  const buckets = new Map<string, OpenInboxItem[]>();
  for (const item of items) {
    // A null contactId means "no linked contact" as far as grouping goes —
    // each such item stands alone rather than collapsing every unlinked item
    // into one false group just because they share the same null key.
    const key = item.contactId ?? `item:${item.id}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const groups: InboxGroup[] = [];
  for (const [key, members] of buckets) {
    members.sort(byOldestFirst);
    groups.push({
      key,
      contactId: members[0].contactId,
      members,
      primary: members[0],
      newest: members[members.length - 1],
      sourceCounts: members.reduce<Partial<Record<InboxSource, number>>>((acc, m) => {
        acc[m.source] = (acc[m.source] ?? 0) + 1;
        return acc;
      }, {}),
    });
  }

  // Groups sort by their oldest (primary) member, same invariant as the flat
  // list — otherwise a customer's older, more-overdue thread could get
  // buried under a newer one just because it happened to group with a fresh
  // sibling.
  groups.sort((a, b) => byOldestFirst(a.primary, b.primary));
  return groups;
}
