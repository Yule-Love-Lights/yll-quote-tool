// src/lib/integrations/bouncie.ts — Bouncie fleet-GPS webhook helpers
// (ledger row 403, phase 2).
//
// HOW BOUNCIE PROVES A WEBHOOK IS FROM BOUNCIE. A static shared secret that WE
// choose (`authKey`, set when the webhook is registered) and that Bouncie echoes
// back verbatim on every delivery, in BOTH of these headers:
//
//     Authorization: <authKey>
//     X-Bouncie-Authorization: <authKey>
//
// The second exists for platforms that strip `Authorization`. We read either.
// This is the same shape as the Telegram bot's `x-telegram-bot-api-secret-token`
// check, which is what row 403 constraint (b) assumed and which the real spec
// confirmed.
//
// WHAT IT IS NOT: an HMAC over the request body. It proves the caller knows the
// secret and nothing more — no payload binding, no replay protection. That is
// why the receiver pairs it with HTTPS-only, a CONSTANT-TIME compare, and
// content-hash idempotency rather than trusting the header alone.
//
// ⚠️ THE ROTATION FOOTGUN. Bouncie rotates the key when our endpoint returns a
// NEW VALUE IN AN `Authorization` RESPONSE HEADER. If the route ever sets that
// response header for any reason, Bouncie silently adopts whatever it contains
// and every later delivery fails our check — a self-inflicted outage with no
// error anywhere. The route must never set an `Authorization` response header,
// and there is a test asserting exactly that.

import { createHash } from 'node:crypto';
import { safeEqual } from '@/lib/security';

/** True when the webhook secret is configured. Everything fails closed without it. */
export function isBouncieWebhookConfigured(): boolean {
  return !!process.env.BOUNCIE_WEBHOOK_SECRET;
}

/**
 * True when an inbound request carries our shared secret.
 *
 * Fails closed on a missing expected value, so an unset `BOUNCIE_WEBHOOK_SECRET`
 * can never mean "accept everything". Set the secret in the environment BEFORE
 * registering the webhook with Bouncie: a webhook that keeps getting rejected is
 * eventually auto-deactivated on their side, and that ordering avoids it.
 *
 * Either header satisfies the check, because Bouncie sends the same value in
 * both and some platforms strip `Authorization` in transit.
 */
export function verifyBouncieSecret(
  authorizationHeader: string | null | undefined,
  bouncieHeader: string | null | undefined,
  expected: string | undefined = process.env.BOUNCIE_WEBHOOK_SECRET,
): boolean {
  if (!expected) return false;
  return safeEqual(authorizationHeader ?? undefined, expected) || safeEqual(bouncieHeader ?? undefined, expected);
}

/** sha256 of the exact request body — the idempotency key for a redelivery. */
export function bodyHash(rawBody: string): string {
  return createHash('sha256').update(rawBody, 'utf8').digest('hex');
}

export type BouncieEventFacts = {
  eventType?: string;
  imei?: string;
  vin?: string;
  transactionId?: string;
  occurredAt?: string;
};

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** An ISO timestamp, or undefined if it is missing or not a real date. */
function isoTimestamp(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/**
 * Pull the few facts worth indexing out of a payload, TOLERANTLY.
 *
 * Every field is optional and nothing here throws or rejects. A payload that
 * does not match the published spec still gets stored with whatever could be
 * read from it, because catching that mismatch is this phase's whole purpose.
 *
 * Where the timestamp lives depends on the event, and the spec is specific:
 *   tripStart          -> start.timestamp        (NO location on this event)
 *   tripEnd            -> end.timestamp          (NO location on this event)
 *   tripData           -> the LAST data[].timestamp — the freshest point in the
 *                         batch, which is the one a staleness check cares about
 *   applicationGeozone -> geozone.timestamp
 *   userGeozone        -> geozone.timestamp
 */
export function parseBouncieEvent(body: unknown): BouncieEventFacts {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;

  const facts: BouncieEventFacts = {
    eventType: str(b.eventType),
    imei: str(b.imei),
    vin: str(b.vin),
    transactionId: str(b.transactionId),
  };

  const sub = (key: string): Record<string, unknown> | undefined => {
    const v = b[key];
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  };

  facts.occurredAt =
    isoTimestamp(sub('start')?.timestamp) ??
    isoTimestamp(sub('end')?.timestamp) ??
    isoTimestamp(sub('geozone')?.timestamp) ??
    lastTripDataTimestamp(b.data);

  return facts;
}

/** Freshest timestamp in a `tripData` batch, scanning from the end. */
function lastTripDataTimestamp(data: unknown): string | undefined {
  if (!Array.isArray(data)) return undefined;
  for (let i = data.length - 1; i >= 0; i -= 1) {
    const point = data[i];
    if (point && typeof point === 'object') {
      const ts = isoTimestamp((point as Record<string, unknown>).timestamp);
      if (ts) return ts;
    }
  }
  return undefined;
}
