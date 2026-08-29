import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The crew door.
 *
 * Crew logins were retired (row 438): field crew work through the Telegram bot,
 * and `crew_members.telegram_user_id` is the identity we already hold for them.
 * So the door is a SIGNED LINK, not a password: a short-lived link token is
 * handed to one crew member, the entry route exchanges it for a longer-lived
 * session cookie, and every request re-reads the crew row, so deactivating a
 * crew member or unlinking their Telegram account ends the session at once.
 *
 * Two purposes share the format and can NEVER be swapped: a 15-minute link that
 * travels over a chat app is not a 30-day cookie, and a stolen cookie is not a
 * replayable entry link. The purpose is inside the signed payload, so forging
 * one from the other means forging the signature.
 *
 * Fails CLOSED: with no CREW_LINK_SECRET set, nothing mints and nothing
 * verifies.
 */

export type CrewTokenPurpose = 'link' | 'session';

/** A link travels through a chat app, so it lives minutes, not days. */
export const CREW_LINK_TTL_MS = 15 * 60 * 1000;
/** A session lives on the crew member's own phone. */
export const CREW_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const PREFIX = 'c1';

export type CrewTokenResult =
  | { ok: true; crewMemberId: string }
  | { ok: false; reason: 'unconfigured' | 'malformed' | 'bad_signature' | 'expired' | 'wrong_purpose' };

type Payload = { v: 1; p: CrewTokenPurpose; c: string; e: number };

function secret(): string | null {
  const s = process.env.CREW_LINK_SECRET?.trim();
  return s ? s : null;
}

function sign(payloadB64: string, key: string): string {
  return createHmac('sha256', key).update(`${PREFIX}.${payloadB64}`).digest('base64url');
}

function ttlFor(purpose: CrewTokenPurpose): number {
  return purpose === 'link' ? CREW_LINK_TTL_MS : CREW_SESSION_TTL_MS;
}

/** Mint a token for one crew member. Throws if the secret is missing, because a
 * caller that silently got no token would look like a caller that got one. */
export function mintCrewToken(purpose: CrewTokenPurpose, crewMemberId: string, nowMs: number): string {
  const key = secret();
  if (!key) throw new Error('CREW_LINK_SECRET is not set: the crew door is closed');
  const payload: Payload = { v: 1, p: purpose, c: crewMemberId, e: nowMs + ttlFor(purpose) };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${PREFIX}.${payloadB64}.${sign(payloadB64, key)}`;
}

/** Verify a token for the purpose the caller expects. Never throws. */
export function verifyCrewToken(
  purpose: CrewTokenPurpose,
  token: string | null | undefined,
  nowMs: number,
): CrewTokenResult {
  const key = secret();
  if (!key) return { ok: false, reason: 'unconfigured' };
  if (!token) return { ok: false, reason: 'malformed' };

  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) {
    return { ok: false, reason: 'malformed' };
  }
  const [, payloadB64, providedSig] = parts as [string, string, string];

  const expected = Buffer.from(sign(payloadB64, key), 'utf8');
  const provided = Buffer.from(providedSig, 'utf8');
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as Payload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (payload?.v !== 1 || typeof payload.c !== 'string' || !payload.c || typeof payload.e !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (payload.p !== purpose) return { ok: false, reason: 'wrong_purpose' };
  if (nowMs > payload.e) return { ok: false, reason: 'expired' };

  return { ok: true, crewMemberId: payload.c };
}
