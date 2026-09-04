// What backed a follow-up stamp, in words (ledger row 502, Naldo 2026-09-03).
//
// A "Followed" stamp asserts somebody chased this customer. Until now nothing
// recorded WHETHER anything in the system corroborates that, so a staffer who
// genuinely rang from a personal phone and a row stamped by a mis-click looked
// identical. Found on a forwarded lead that escalated twice and was then
// stamped by hand with no outbound call or message on record anywhere.
//
// Naldo's decisions, 2026-09-03, all three:
//   • a recorded CALL or a message this tool SENT both count as backing
//   • the marker shows on the row in the inbox, not only in its history
//   • it changes only what is SHOWN. The stamp still works exactly as before,
//     nothing is blocked, and the follow-up nag is still retired.
//
// That last one is why this file has no guard in it. The marker is a label on
// a claim, not a judgement about the staffer: "nothing recorded backs this" is
// true of every call made from a personal phone, which the tool cannot see and
// which is a perfectly ordinary way to ring a customer.

/** How a follow-up stamp came to be written. Stored in inbox_items.followed_via. */
export type FollowedVia = 'call' | 'reply' | 'manual';

/**
 * Whether anything in the system corroborates the stamp.
 *
 * `unknown` is a real and separate answer, not a synonym for `unbacked`: rows
 * stamped before the column existed carry null, and rendering those as
 * unbacked would invent a claim about work that may well have happened. The
 * migration deliberately does not backfill for the same reason.
 */
export type FollowBacking = 'backed' | 'unbacked' | 'unknown';

export function followBackingOf(via: string | null | undefined): FollowBacking {
  if (via === 'call' || via === 'reply') return 'backed';
  if (via === 'manual') return 'unbacked';
  // Anything else, including null and a value some future caller invents, is
  // UNKNOWN rather than unbacked. Failing closed here would mean the honest
  // direction is the quiet one: an unrecognised value must never accuse.
  return 'unknown';
}

/** The words for a row marker. Null when there is nothing worth saying. */
export function followBackingLabel(via: string | null | undefined): string | null {
  switch (followBackingOf(via)) {
    case 'unbacked':
      // Says what is true of the RECORD, never what the staffer did or did not
      // do. "No call or text on record" is checkable; "nobody called" is not.
      return 'No call or text on record';
    case 'backed':
    case 'unknown':
    default:
      return null;
  }
}

/** Whether the row should carry the marker at all. */
export function showsFollowBackingMarker(via: string | null | undefined): boolean {
  return followBackingLabel(via) !== null;
}

/**
 * What a caller passing nothing should be recorded as.
 *
 * `manual`, deliberately: an unknown future caller that does not say what
 * backed its stamp is, by definition, a stamp with nothing recorded behind it.
 * Recording those as `call` or leaving them null would let a whole new
 * unbacked path arrive wearing a label that says it was fine.
 */
export const DEFAULT_FOLLOWED_VIA: FollowedVia = 'manual';
