/**
 * Validation for a Telegram user id, shared by every admin door that writes
 * `crew_members.telegram_user_id`.
 *
 * There is ONE such door today, `/api/admin/staff`. There were briefly two, and
 * keeping them agreeing byte for byte on what a valid id is — same column, same
 * partial unique index, same webhook lookup reading it back — is part of why
 * they were merged. This module stays separate anyway: the rule belongs with the
 * column rather than with whichever route happens to write it, and the webhook
 * that consumes the value lives somewhere else entirely.
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

/**
 * Narrow a parsed JSON request body to a plain object, or null.
 *
 * `req.json()` happily returns a JSON PRIMITIVE for a body like `42`, `true` or
 * `"x"`, and a route that then does `'key' in body` throws a TypeError rather
 * than returning its own 400. Optional chaining (`body?.key`) hides the problem
 * on some lines and not others, so the narrowing happens once, here, at the
 * edge. Arrays are rejected too: a request body is an object or it is a
 * client bug.
 */
export function asJsonObject(raw: unknown): Record<string, unknown> | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw as Record<string, unknown>;
}

export function parseTelegramUserId(raw: unknown): TelegramUserIdParse {
  if (raw === undefined) return { ok: false, reason: 'missing' };
  const trimmed = raw === null ? '' : String(raw).trim();
  if (trimmed === '') return { ok: true, telegramUserId: null };
  if (!isValidTelegramUserId(trimmed)) return { ok: false, reason: 'invalid' };
  return { ok: true, telegramUserId: trimmed };
}
