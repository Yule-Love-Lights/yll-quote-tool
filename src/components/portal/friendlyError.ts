// Customer-facing portal error copy (audit fix g10 / ledger #90). The portal must
// NEVER surface a raw server/network error to the customer — those leak internals
// ("Supabase service role not configured", Postgres messages, "Failed to fetch",
// HTTP codes). Components log the raw error for debugging and render the output of
// this helper instead. Pure + unit-tested so the no-leak invariant can't regress.
//
// By construction the helper only accepts a human ACTION phrase (e.g. "start
// checkout", "record your approval"), so a raw error can't pass through it.

const DEFAULT_PHONE = '(631) 517-0186';

/** The portal contact phone — configured value, or the business default. */
export function portalPhone(): string {
  return process.env.NEXT_PUBLIC_PORTAL_PHONE?.trim() || DEFAULT_PHONE;
}

/**
 * Friendly, recoverable error copy for a failed portal action. `action` is a
 * short verb phrase describing what the customer was trying to do.
 *   friendlyPortalError('start checkout')
 *   → "We couldn't start checkout just now — please try again, or text us at …"
 */
export function friendlyPortalError(action: string, phone: string = portalPhone()): string {
  return `We couldn't ${action} just now — please try again, or text us at ${phone}.`;
}

/**
 * View-only portal (#176) — a stale tab: the portal was open before staff
 * flagged this quote view-only, so an in-flight approve/pay/decline/
 * request-changes call 409s with code 'view-only'. Deliberately NOT
 * `friendlyPortalError` — "please try again" is misleading here (retrying can
 * never succeed while the quote stays view-only), so this names the real
 * state instead.
 *   viewOnlyStaleTabError()
 *   → "This quote is now browse-only — nothing can be approved or paid here. Text us at … if that doesn't seem right."
 */
export function viewOnlyStaleTabError(phone: string = portalPhone()): string {
  return `This quote is now browse-only — nothing can be approved or paid here. Text us at ${phone} if that doesn't seem right.`;
}

/**
 * NCE trade-account balance (#199) — an NCE-tagged quote's remaining balance
 * settles through the NCE trade system, never a card/pay-link. Same "name
 * the real state, don't say retry" posture as viewOnlyStaleTabError — retrying
 * pay-balance can never succeed here. This is the ONE deliberate NCE-facing
 * message on the customer portal.
 *   nceBalanceBlockedError()
 *   → "This balance is handled through your NCE trade account — nothing is due here. Text us at … with any questions."
 */
export function nceBalanceBlockedError(phone: string = portalPhone()): string {
  return `This balance is handled through your NCE trade account — nothing is due here. Text us at ${phone} with any questions.`;
}

/**
 * Stale invoice balance (row 378) — the amount on the invoice no longer
 * reconciles with the order's current agreed total, so the pay-balance route
 * refuses rather than charge a figure we can't stand behind (code
 * 'invoice-stale'). Same "name the real state, don't say retry" posture as
 * viewOnlyStaleTabError/nceBalanceBlockedError: retrying cannot succeed until
 * a human reconciles the invoice.
 *
 * The wording deliberately does NOT claim "we've notified our team" even
 * though the route does fire a staff alert — that alert is best-effort (it
 * no-ops when the Telegram bot is dormant or unconfigured), and customer copy
 * must never assert something the system might not have done. It states what
 * has to happen and hands the customer a channel that always works.
 *   invoiceStaleError()
 *   → "We need to confirm the final amount on this order before taking payment — please text us at … and we'll get it sorted right away."
 */
export function invoiceStaleError(phone: string = portalPhone()): string {
  return (
    `We need to confirm the final amount on this order before taking payment — ` +
    `please text us at ${phone} and we'll get it sorted right away.`
  );
}
