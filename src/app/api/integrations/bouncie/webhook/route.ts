// src/app/api/integrations/bouncie/webhook/route.ts
// Bouncie fleet-GPS webhook receiver (ledger row 403, phase 2).
//
//   POST — an event for one of our tracked vehicles. Verifies the shared secret,
//   stores the body exactly as it arrived, and DECIDES NOTHING.
//   GET  — 200, for an ops reachability check. Bouncie itself only POSTs.
//
// WHY THIS DOES SO LITTLE, DELIBERATELY. The devices are new and nothing has
// ever seen a real Bouncie payload. Two of row 403's search-sourced vendor facts
// were already wrong when the real spec was read; the spec can be wrong about
// reality the same way. So the first build is an instrument: capture the truth,
// then design against it. The map, the geofences and the arrive/depart
// suggestions all wait for a real event to confirm the shape.
//
// ROW 403 CONSTRAINT (a), ABSOLUTE: GPS NEVER WRITES PAYROLL. This route writes
// to exactly one table, `vehicle_events`. It does not import, reference or reach
// `job_segments`, `shifts` or `jobs`, and it never will. A geofence may only
// SUGGEST an arrive/depart to a crew member's own device, and a human still
// affirmatively taps — no default-accept, no auto-confirm-on-timeout.
//
// ROW 403 CONSTRAINT (b): this path is in `PUBLIC_API_EXACT` in
// `src/lib/auth/operatorGate.ts` in this same PR, because a Bouncie request
// carries no operator session and the perimeter would 401 it before this route's
// own secret check ever ran. That gap has produced four prod incidents in this
// repo, so it is verified here by a signed-out request test, not by inspection.
//
// ⚠️ NEVER SET AN `Authorization` RESPONSE HEADER. Bouncie rotates our shared
// secret when the endpoint returns a new value in one. Setting it by accident
// silently adopts that value and breaks every later delivery, with no error
// anywhere. A test asserts the response carries no such header.
//
// STATUS CODES ARE LOAD-BEARING. Bouncie retries on a timeout or any non-2xx
// with exponential backoff, and a webhook that keeps failing is AUTO-DEACTIVATED
// until a human re-enables it. So the only failure we answer with 401 is a bad
// or missing secret, which is a real security answer worth the retries. An
// unreadable or unexpected body still gets stored and still returns 200 —
// rejecting a payload we do not understand would throw away the one thing this
// phase exists to catch.

import { NextRequest, NextResponse } from 'next/server';
import { verifyBouncieSecret, bodyHash, parseBouncieEvent, isOffHours } from '@/lib/integrations/bouncie';
import { getSupabaseServiceClient } from '@/lib/supabase';
import { parseGeozoneEvent, recordGeozoneVisit } from '@/lib/integrations/vehicleVisits';
import { rateLimitResponse } from '@/lib/rateLimit';

export const runtime = 'nodejs';

/** Cap on a single stored body. Comfortably above a full tripData batch. */
const MAX_BODY_BYTES = 1_000_000;

export async function GET() {
  return new NextResponse('OK', { status: 200 });
}

export async function POST(req: NextRequest) {
  // Rate limit first, matching the sibling webhooks (ghl/webhook, homeworks/
  // signed). Bouncie sends bursts by design — an offline device dumps a buffered
  // trip on reconnect — so the ceiling is generous; it exists to bound an
  // attacker who has learned the secret, not to shape normal traffic.
  const limited = rateLimitResponse(req, { bucket: 'bouncie-webhook', limit: 300, windowMs: 60_000 });
  if (limited) return limited;

  // The secret is header-only, so check it BEFORE buffering a body. Reading
  // first let an unauthenticated caller make us hold their payload in memory for
  // no reason (S68 security lens). Fails closed when BOUNCIE_WEBHOOK_SECRET is
  // unset, so an unconfigured deploy can never accept an unauthenticated write.
  if (
    !verifyBouncieSecret(req.headers.get('authorization'), req.headers.get('x-bouncie-authorization'))
  ) {
    return new NextResponse('Bad secret', { status: 401 });
  }

  // Reject an oversized body on its declared length, before reading it. A body
  // with no Content-Length is still measured after the read, below.
  const declaredLength = Number(req.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    console.warn('[bouncie] rejected an oversized webhook body (declared):', declaredLength);
    return NextResponse.json({ ok: true, stored: false, reason: 'oversized' });
  }

  const raw = await req.text();

  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    // Worth knowing about loudly rather than storing. 200 so Bouncie does not
    // retry a body that would fail again identically.
    console.warn('[bouncie] rejected an oversized webhook body:', Buffer.byteLength(raw, 'utf8'));
    return NextResponse.json({ ok: true, stored: false, reason: 'oversized' });
  }

  // A body that is not JSON is stored anyway, wrapped. A spec mismatch is the
  // most valuable thing this route can catch, so it must never be discarded.
  let parsed: unknown;
  let payload: unknown;
  try {
    parsed = JSON.parse(raw);
    payload = parsed;
  } catch {
    parsed = undefined;
    payload = { _unparsed: raw };
  }

  const facts = parseBouncieEvent(parsed);
  const sb = getSupabaseServiceClient();
  if (!sb) {
    // Non-2xx on purpose: this one IS worth a retry, because the event is real
    // and the failure is ours and transient.
    console.error('[bouncie] service client unavailable; event not stored');
    return new NextResponse('Storage unavailable', { status: 503 });
  }

  const { data: inserted, error } = await sb
    .from('vehicle_events')
    .insert({
      event_type: facts.eventType ?? null,
      imei: facts.imei ?? null,
      vin: facts.vin ?? null,
      transaction_id: facts.transactionId ?? null,
      occurred_at: facts.occurredAt ?? null,
      // Constraint (f): tagged at insert so a retention job never has to re-parse
      // payloads to find out which rows are a crew member's private evenings.
      occurred_off_hours: isOffHours(facts.occurredAt) ?? null,
      body_sha256: bodyHash(raw),
      payload,
    })
    .select('id');

  if (error) {
    // 23505 = unique violation on body_sha256: a byte-identical redelivery, which
    // Bouncie documents as normal (overlapping real-time and periodic streams,
    // plus retries). Already stored, so this is a success, not a failure.
    if (error.code === '23505') {
      return NextResponse.json({ ok: true, stored: false, reason: 'duplicate' });
    }
    console.error('[bouncie] failed to store event:', error.message);
    return new NextResponse('Storage failed', { status: 503 });
  }

  // DERIVED, AND DELIBERATELY BEST-EFFORT. A geofence event also opens or closes
  // a visit on the GPS timeline (row 403 phase 3b, the second clock). This runs
  // AFTER the raw event is safely stored and can never change the response:
  // the capture is the source of truth and can be reprocessed, whereas answering
  // Bouncie with an error gets the webhook retried and eventually deactivated.
  //
  // Constraint (a) still holds here — the visit timeline has no foreign key into
  // shifts or job_segments, and nothing below writes payroll.
  const eventId = inserted?.[0]?.id;
  if (eventId) {
    try {
      const geo = parseGeozoneEvent(parsed, eventId, facts.occurredAt ?? null);
      if (geo) {
        const outcome = await recordGeozoneVisit(geo);
        if (outcome.action === 'ignored') {
          console.info('[bouncie] geozone event not recorded as a visit:', outcome.reason);
        }
      }
    } catch (err) {
      console.error('[bouncie] visit derivation failed (event IS stored):', err instanceof Error ? err.message : String(err));
    }
  }

  return NextResponse.json({ ok: true, stored: true });
}
