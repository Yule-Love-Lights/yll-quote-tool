import { NextResponse } from 'next/server';

/**
 * Shared cron-request auth.
 *
 * WHY THIS EXISTS: every cron in this repo hand-rolled the same check —
 *
 *   if (!secret || !safeEqual(header, `Bearer ${secret}`)) return 401;
 *
 * — which answers 401 for BOTH "you sent the wrong token" and "CRON_SECRET is
 * not set on this deployment". Those are completely different problems: one is a
 * caller error, the other means EVERY run of that cron has been failing since
 * the variable went missing, and nothing says so.
 *
 * That is not hypothetical. The sibling yll-call-copilot project ran dark for
 * 8+ days for exactly this reason — every cron returned an auth error, zero
 * sales calls were captured, and the identical response bodies made it read as a
 * caller problem rather than a config one (ledger row 286).
 *
 * So: 503 naming the missing variable when unconfigured, 401 when the token is
 * simply wrong. A monitor watching for 5xx now sees a dead cron; a 401 stays a
 * caller's problem.
 */

export type CronAuthResult = 'ok' | 'unauthorized' | 'unconfigured';

/** Constant-time-ish compare, so a wrong token cannot be probed byte by byte. */
function safeEqual(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Classify a cron request. PURE apart from reading the env, so it is testable.
 *
 * ONLY absent/empty counts as unconfigured. An earlier draft also rejected any
 * secret under 16 characters as a "placeholder" — which would have classified a
 * perfectly real but shorter prod secret as unconfigured and 503'd all eleven
 * crons at once, converting a working system into a dead one. The distinction
 * that actually matters here is set vs not set; secret STRENGTH is a separate
 * concern and not something this guard should enforce by breaking production.
 */
export function verifyCronRequest(
  authorizationHeader: string | null | undefined,
  secret: string | undefined = process.env.CRON_SECRET,
): CronAuthResult {
  if (!secret) return 'unconfigured';
  return safeEqual(authorizationHeader ?? undefined, `Bearer ${secret}`) ? 'ok' : 'unauthorized';
}

/**
 * The response to return directly, or null when the request is authorized.
 *
 *   const denied = cronDenial(req.headers.get('authorization'));
 *   if (denied) return denied;
 */
export function cronDenial(
  authorizationHeader: string | null | undefined,
  secret: string | undefined = process.env.CRON_SECRET,
): NextResponse | null {
  const result = verifyCronRequest(authorizationHeader, secret);
  if (result === 'ok') return null;
  if (result === 'unconfigured') {
    // Names the variable on purpose: the whole point is that a human reading the
    // log or the response knows what to fix without guessing.
    return NextResponse.json(
      { error: 'CRON_SECRET is not configured on this deployment' },
      { status: 503 },
    );
  }
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
