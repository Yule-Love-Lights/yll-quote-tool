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
