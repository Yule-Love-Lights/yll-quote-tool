// When a phone call counts as "we followed up on this inbox item".
//
// Naldo's ask (2026-09-02): staff phone people from the /inbox "In the works"
// list all the time, and nothing recorded it — the row kept nagging as though
// nobody had reached out. Calls are already captured in `call_recordings`
// (direction, called_at, duration_seconds, ghl_contact_id), so the inbox can
// read them instead of asking staff to click a second button after hanging up.
//
// Everything here is PURE and takes its times as arguments, so the rule is
// testable without a database and without a clock.
//
// THE RULE, and why each clause is there. Measured against prod on 2026-09-02:
//   • OUTBOUND only. An inbound call is the customer chasing US, which is the
//     opposite of a follow-up; snoozing a row for it would hide someone who is
//     actively trying to reach us.
//   • 30 SECONDS or more. This is the clause that decides whether the feature
//     tells the truth. Counting any outbound call would have cleared 55 of the
//     80 never-followed rows on day one, most of them rings that nobody
//     answered; at 30 seconds it clears 7, and those 7 are real conversations.
//     Naldo's call, given both numbers.
//   • STRICTLY AFTER an anchor (below). A call placed before the customer went
//     quiet was not a follow-up on this silence.
//   • NOT a test record.

/** The shortest outbound call that counts as having reached someone. */
export const MIN_CALL_SECONDS = 30;

export type CallRow = {
  direction: string | null;
  durationSeconds: number | null;
  calledAt: Date;
  isTest: boolean;
};

export type AnchorInput = {
  /** inbox_items.followed_up_at — when we last said we had followed up. */
  followedUpAt: Date | null;
  /** inbox_items.last_inbound_at — when the customer last contacted us. */
  lastInboundAt: Date | null;
  /** inbox_items.last_message_at — the fallback when we have no inbound time. */
  lastMessageAt: Date | null;
};

/**
 * The moment a call has to beat to count as a NEW outreach on this row.
 *
 * The later of two things, because the two live rows this feature serves need
 * different anchors and one rule has to cover both:
 *
 *   • A row nobody has followed up on yet (`followed_up_at` null) anchors on
 *     when the customer last contacted us. 30 of the 80 such rows in prod carry
 *     no `last_inbound_at`, so the `last_message_at` fallback is load-bearing
 *     rather than defensive, and is written out here rather than left implied.
 *
 *   • A row already marked followed that has gone quiet AGAIN — the re-chase
 *     case, which is every row in the screenshot that prompted this work —
 *     anchors on the follow-up stamp itself. Only a call placed since we last
 *     claimed to have followed up is a fresh outreach.
 *
 * Taking the LATER of the two is what makes one rule serve both: an unfollowed
 * row has no stamp to beat, and a followed row whose customer has written since
 * correctly anchors on that newer message instead.
 *
 * Null when the row carries no usable time at all, which `callQualifies` treats
 * as "nothing to beat".
 */
export function followUpAnchor(input: AnchorInput): Date | null {
  const customerSide = input.lastInboundAt ?? input.lastMessageAt ?? null;
  const candidates = [input.followedUpAt, customerSide].filter((d): d is Date => d != null);
  if (candidates.length === 0) return null;
  return candidates.reduce((latest, d) => (d.getTime() > latest.getTime() ? d : latest));
}

/**
 * Whether this call counts as us having followed up, given the row's anchor.
 *
 * STRICTLY after the anchor, and that strictness is what makes the whole sweep
 * idempotent rather than merely careful: the caller stamps `followed_up_at` at
 * the CALL's own time, so on the next run that same call is no longer after the
 * anchor and cannot fire twice. There is no "already processed" bookkeeping to
 * keep in sync, because the data itself carries the answer.
 */
export function callQualifies(call: CallRow, anchor: Date | null): boolean {
  if (call.isTest) return false;
  if (call.direction !== 'outbound') return false;
  if (call.durationSeconds == null || call.durationSeconds < MIN_CALL_SECONDS) return false;
  if (anchor != null && call.calledAt.getTime() <= anchor.getTime()) return false;
  return true;
}

export type CallFollowUpItem = AnchorInput & {
  id: string;
  /** dashboard_contacts.ghl_contact_id — how an item reaches its calls. */
  ghlContactId: string | null;
};

export type ContactCall = CallRow & { ghlContactId: string | null };

export type CallFollowUpStamp = { itemId: string; calledAt: Date };

/**
 * Decide which inbox items a set of calls should mark followed, and at what
 * time. PURE, so the whole rule is testable without a database — this repo's
 * planIngest / quoteFollowUpDecision pattern.
 *
 * Returns the LATEST qualifying call per item, because a staffer who rang
 * someone three times has most recently reached them on the third call, and
 * stamping the earliest would leave the row looking staler than it is.
 *
 * Stamps at the CALL's own time rather than "now". Two reasons, and the second
 * is the important one: it is the honest date (we reached out then), and it
 * makes the sweep idempotent by construction. The caller writes
 * followed_up_at = calledAt, which becomes the row's new anchor, so the same
 * call is no longer strictly after it and cannot fire a second time. There is
 * no processed-marker to keep in sync and nothing to go stale.
 */
export function planCallFollowUps(input: {
  items: CallFollowUpItem[];
  calls: ContactCall[];
}): CallFollowUpStamp[] {
  const callsByContact = new Map<string, ContactCall[]>();
  for (const c of input.calls) {
    if (!c.ghlContactId) continue;
    const list = callsByContact.get(c.ghlContactId);
    if (list) list.push(c);
    else callsByContact.set(c.ghlContactId, [c]);
  }

  const stamps: CallFollowUpStamp[] = [];
  for (const item of input.items) {
    if (!item.ghlContactId) continue; // unmatched contact: nothing to read
    const candidates = callsByContact.get(item.ghlContactId);
    if (!candidates) continue;
    const anchor = followUpAnchor(item);
    let latest: Date | null = null;
    for (const c of candidates) {
      if (!callQualifies(c, anchor)) continue;
      if (latest == null || c.calledAt.getTime() > latest.getTime()) latest = c.calledAt;
    }
    if (latest) stamps.push({ itemId: item.id, calledAt: latest });
  }
  return stamps;
}
