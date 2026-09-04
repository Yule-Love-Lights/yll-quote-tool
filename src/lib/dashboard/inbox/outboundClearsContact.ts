// Reaching a customer anywhere clears their open rows (Naldo, 2026-09-03).
//
// THE CASE THAT PROMPTED IT. A customer emailed on 17 August. Her request was
// actioned six minutes later on a quotetool row, confirmed a week after that,
// and answered by email on 1 September in a NEW thread. Her original row sat
// open the whole time, because auto-resolve is per conversation: it clears a
// row when THAT row's own last message is outbound, and none of the three
// things we did landed on that thread. The work happened; the row could not
// see it. Naldo's words: "we dealt with the problem, you should be able to
// detect that."
//
// THE RULE HE CHOSE, from three options and knowing the tradeoff: any outbound
// touch to that customer clears their open rows. This is CONTACT level, which
// is deliberately wider than #1168's forwarded-lead clear (message level, and
// staying that way). He was shown the risk before choosing: a customer with two
// open rows about different things has both cleared when you ring about one.
//
// WHAT MAKES IT SAFE ANYWAY, and the guard that matters most: a row is never
// cleared when the customer has written on it AFTER we reached out. That is
// precisely the person still waiting for an answer, and clearing them would be
// the one unrecoverable mistake here, because the row is how staff know to
// answer. The same idea already exists as markItemFollowed's
// requireNoInboundAfter; this mirrors it rather than inventing a new shape.

export type ContactRowForClear = {
  id: string;
  status: string;
  /** The row's own last message. */
  lastMessageAt: Date | null;
  /** The last time the CUSTOMER wrote on this row, if ever. */
  lastInboundAt: Date | null;
};

export type OutboundReach = {
  /** When we reached them. */
  at: Date;
  /** The item this outbound touch itself created or updated, never re-cleared. */
  originItemId?: string | null;
};

/**
 * Whether one open row is answered by an outbound touch to the same customer.
 *
 * Every refusal below is a case where clearing would hide someone who still
 * needs a person, so each one fails CLOSED: an unknown or missing timestamp
 * leaves the row alone rather than guessing it is finished.
 */
export function outboundClearsRow(row: ContactRowForClear, outbound: OutboundReach): boolean {
  // Only a row still waiting on us. 'handled' rows are already dealt with, and
  // dismissed or completed rows carry a decision a person made.
  if (row.status !== 'unresponded') return false;

  // Never the row this very touch just wrote. That one is the existing
  // per-conversation path's job, and clearing it here would double-log.
  if (outbound.originItemId && row.id === outbound.originItemId) return false;

  // A row with no clock cannot be shown to predate the outbound, so it stays.
  if (!row.lastMessageAt) return false;

  // The outbound must come AFTER the row. Reaching someone cannot retroactively
  // answer a message they sent later.
  if (outbound.at.getTime() <= row.lastMessageAt.getTime()) return false;

  // THE ONE THAT MATTERS. If the customer wrote on this row after we reached
  // out, they are waiting on us right now and this row is the only thing that
  // says so.
  if (row.lastInboundAt && row.lastInboundAt.getTime() >= outbound.at.getTime()) return false;

  return true;
}

/** The ids an outbound touch clears. PURE. Order preserved. */
export function rowsClearedByOutbound(
  rows: ContactRowForClear[],
  outbound: OutboundReach,
): string[] {
  return rows.filter((r) => outboundClearsRow(r, outbound)).map((r) => r.id);
}
