/**
 * Validation for a Telegram user id, shared by every admin door that writes
 * `crew_members.telegram_user_id`.
 *
 * There are two such doors now: `/api/admin/crew-accounts` (field crew) and
 * `/api/admin/office-staff` (office staff). They must agree byte for byte on
 * what a valid id is, because they write the SAME column, guarded by the same
 * partial unique index, and read back by the same webhook lookup. Two copies of
 * this rule is how one door starts accepting something the other rejects.
 *
 * Telegram user ids are positive integers. Digits-only keeps a pasted @handle
 * ("@sonson") from being stored as a link that can never match, because the
 * webhook resolves the sender from `String(msg.from.id)`.
 *
 * A LEADING ZERO is rejected for the same reason: `String(Number)` never
 * produces one, so "0123456789" is a typo that would store cleanly and then
 * silently never match a single inbound message.
 */
export const TELEGRAM_USER_ID_RE = /^[1-9]\d{0,19}$/;

/** The message every door shows for a malformed id. One wording, one place. */
export const TELEGRAM_USER_ID_ERROR =
  'That is not a Telegram user id. It is a number, not an @handle — the crew member can get theirs from @userinfobot.';

export function isValidTelegramUserId(value: string): boolean {
  return TELEGRAM_USER_ID_RE.test(value);
}

/**
 * Normalize a raw request value into either a Telegram id or an explicit unlink.
 *
 * `null` / `''` mean UNLINK. `undefined` is NOT the same thing: a missing key
 * means the caller sent nothing to change and is almost certainly a bug, so it
 * is reported separately rather than silently unlinking someone's time clock.
 */
export type TelegramUserIdParse =
  | { ok: true; telegramUserId: string | null }
  | { ok: false; reason: 'missing' | 'invalid' };

export function parseTelegramUserId(raw: unknown): TelegramUserIdParse {
  if (raw === undefined) return { ok: false, reason: 'missing' };
  const trimmed = raw === null ? '' : String(raw).trim();
  if (trimmed === '') return { ok: true, telegramUserId: null };
  if (!isValidTelegramUserId(trimmed)) return { ok: false, reason: 'invalid' };
  return { ok: true, telegramUserId: trimmed };
}
