// Whether marking an inbox item "Not a lead" should also silence its sender
// for good (S75, Naldo 2026-08-29).
//
// It always did, unconditionally, and that is how five paying customers ended
// up silenced. Traced from the live rows:
//
//   - Gabrielle Moronta, Michael Vahling, Andrew Bykov: someone dismissed a
//     `quotetool` row, the one that reads "Quote — $1,799.81". That row is the
//     quote tool telling us we sent a quote. It is genuinely not a lead, so
//     dismissing it is the right click. But its contact is the CUSTOMER, so
//     dismissing it suppressed the customer's own email. All three went on to
//     book.
//   - Susan Pace-Burke: someone dismissed a "New Lead from GML Media" forward.
//     The forwarder's mail is parsed so the item carries the CUSTOMER's details
//     rather than the forwarding robot's, which is what makes those forwards
//     useful, and also what made dismissing one silence her.
//   - Dorinda Novak: a spam SMS arrived on her contact. Dismissing the spam was
//     right; suppressing her phone and email was not.
//
// The common shape: the identifiers on the item belong to a real person we are
// doing business with, not to whoever sent the annoying thing. Suppression is
// for a repeat sender we never want to hear from again. So the rule is now
// narrow, and it fails CLOSED: suppress only when we have a positive reason to
// believe the sender is not one of our customers.

/** Sources whose items carry OUR customer's identity rather than a sender's. */
const NEVER_SUPPRESS_SOURCES = new Set([
  // The quote tool's own "we sent a quote" notification. The contact is always
  // the customer. Dismissing it is a normal, correct action and must never be
  // a decision about that customer's future mail.
  'quotetool',
  // Homeworks imports, same shape: the row is about a customer, not from a
  // sender we could meaningfully block.
  'homeworks',
]);

export type DismissSuppressionInput = {
  /** inbox_items.source */
  source: string | null | undefined;
  /**
   * True when this item's identity was parsed out of a lead-forwarding
   * platform's mail (GML Media and friends). The identifiers are the
   * forwarded CUSTOMER's, so suppressing them silences a lead we paid for.
   */
  isLeadForward?: boolean;
  /** True when these identifiers match a quote in the tool. */
  isKnownCustomer: boolean;
};

export type DismissSuppressionDecision =
  | { suppress: true }
  | { suppress: false; reason: 'own-notification' | 'lead-forward' | 'known-customer' };

/**
 * Whether a dismiss should silence this sender.
 *
 * The item is dismissed either way. This decides ONLY whether the sender's
 * future messages stop notifying anyone, which is the part that was silently
 * costing us customer mail.
 */
export function shouldSuppressOnDismiss(
  input: DismissSuppressionInput,
): DismissSuppressionDecision {
  if (input.source && NEVER_SUPPRESS_SOURCES.has(input.source)) {
    return { suppress: false, reason: 'own-notification' };
  }
  if (input.isLeadForward) return { suppress: false, reason: 'lead-forward' };
  if (input.isKnownCustomer) return { suppress: false, reason: 'known-customer' };
  return { suppress: true };
}
