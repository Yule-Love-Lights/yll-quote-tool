// Website lead capture (#leads). The company website (WordPress,
// yulelovelights.com) embeds custom quote-request forms per service line
// that POST here. Replaces the old plugin that routed EVERY lead into the
// Christmas pipeline regardless of the service the visitor actually asked
// about — each service now lands its GHL opportunity in its own pipeline
// (src/lib/leads/leadService.ts).
//
// POST /api/leads
// Body: {
//   name, email, phone, service, formVariant   — required
//   address?, notes?, utm?, landingUrl?, isTest?
//   consent: true — required and must be STRICTLY true. Every form variant
//                   requires the consent checkbox to submit; a synced lead
//                   gets the 'new lead' tag, which enrolls it in GHL drips
//                   that send SMS — texting someone who explicitly did not
//                   consent is never acceptable, so false is a 400.
//   company?    — honeypot: real visitors never fill this hidden field
//   elapsedMs?  — CLIENT-computed milliseconds from form render to submit
//                 (both timestamps read off the SAME clock, on the client).
//                 Under 2s = bot-fast. Never a raw client timestamp compared
//                 against the server clock — device-clock skew of a few
//                 seconds would silently bin real visitors as spam.
// }
// Response:
//   { ok: true }        — saved (pending/synced/spam/deferred — see the row)
//   { error: string }   — 400 (bad input) or 429 (rate limited). Never 500 for
//                         a GHL problem — the lead row is always the source of
//                         truth and a background retry can pick up 'pending'.
//
// Design notes:
//   * The row is inserted FIRST, before any GHL call — a GHL outage must
//     never lose a lead. GHL failures are caught and recorded on the row
//     (sync_error), never surfaced to the customer as a failure.
//   * Honeypot / too-fast submits are saved (sync_status 'spam') and answered
//     with the same 200 {ok:true} a real submission gets — indistinguishable
//     to the bot — but never touch GHL.
//   * Rate limit is a DB count (not the in-memory rateLimit.ts module) so it
//     survives across serverless cold starts and multiple regions.
//   * CORS is scoped to the two production origins; a browser-side fetch from
//     any other origin simply won't be able to read the response.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { HighLevelError } from '@/lib/integrations/highlevel';
import { asLeadService, syncLeadToGhl, LEAD_SERVICES, type LeadService } from '@/lib/leads/leadService';
import { appBaseUrl } from '@/lib/integrations/telegramNotify';
import { notifyTelegramAudience } from '@/lib/integrations/telegramRouting';
import { newLeadMessage } from '@/lib/integrations/telegramMessages';
import { sendLeadAlertEmail } from '@/lib/leads/leadAlerts';

export const runtime = 'nodejs';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
// Lowered from 3000 → 2000 (F8): Chrome/password-manager autofill can fill
// the whole form in under 3s for a REAL visitor, which was tripping the
// too-fast spam check as a false positive. 2s still catches scripted bots
// (which submit near-instantly) with more margin for legitimate autofill.
const TOO_FAST_MS = 2000;
const RATE_LIMIT_MAX_PER_HOUR = 5;

// Max lengths per field — anything over is a 400 (a real form never produces
// these; only scripted junk does). Email's 320 is the RFC-side ceiling.
// landingUrl is the one exception: it's auto-populated by the CLIENT (never
// user-typed), so an over-long value is TRUNCATED below instead of 400ing —
// an auto-populated field must never be able to block a real lead.
const MAX_LEN = {
  name: 200,
  email: 320,
  phone: 40,
  address: 500,
  notes: 5000,
  formVariant: 50,
  landingUrl: 1000,
} as const;

// utm is attribution garbage-in by nature — unknown keys and non-string
// values are silently DROPPED (never a 400; bad analytics params must not
// block a lead), surviving values capped at 200 chars. This also keeps a
// non-string value from ever reaching the GHL note as "[object Object]".
const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
const UTM_VALUE_MAX_LEN = 200;

function sanitizeUtm(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const utm: Record<string, string> = {};
  for (const key of UTM_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && value) utm[key] = value.slice(0, UTM_VALUE_MAX_LEN);
  }
  return Object.keys(utm).length > 0 ? utm : null;
}

const ALLOWED_ORIGINS = new Set(['https://yulelovelights.com', 'https://www.yulelovelights.com']);

function corsHeaders(origin: string | null): HeadersInit {
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function jsonResponse(origin: string | null, body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: corsHeaders(origin) });
}

function getIp(req: NextRequest): string | null {
  // Prefer x-real-ip: it's set by our own edge (Vercel), so a client can't
  // spoof it. x-forwarded-for's LEFTMOST entry, by contrast, is whatever the
  // ORIGINAL client sent — every proxy in the chain only APPENDS, never
  // overwrites it — so a request can arrive as
  // "x-forwarded-for: 1.2.3.4, <real proxy ip>" and the spoofed 1.2.3.4
  // would win if we trusted it. Fall back to the leftmost XFF entry only
  // when x-real-ip is absent (e.g. local dev with no reverse proxy).
  const realIp = req.headers.get('x-real-ip');
  if (realIp && realIp.trim()) return realIp.trim();
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim() || null;
  return null;
}

function hlErrorMessage(err: unknown): string {
  return err instanceof HighLevelError
    ? err.message
    : err instanceof Error
      ? err.message
      : 'Unknown HighLevel error';
}

// Redacted for LOGS ONLY (never for the row's sync_error column, which keeps
// full fidelity via hlErrorMessage above). A HighLevelError's message embeds
// GHL's raw response body, which can echo the lead's PII (email/phone/name)
// straight back to us — that must never land in Vercel's logs. Keep only the
// method/path/status portion, before the body.
function redactedHlErrorSummary(err: unknown): string {
  if (err instanceof HighLevelError) {
    const sepIdx = err.message.indexOf(': ');
    return sepIdx === -1 ? err.message : err.message.slice(0, sepIdx);
  }
  return err instanceof Error ? `${err.name}: sync failed` : 'Unknown HighLevel error';
}

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get('origin');
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

type LeadRequestBody = {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  address?: unknown;
  service?: unknown;
  notes?: unknown;
  consent?: unknown;
  utm?: unknown;
  landingUrl?: unknown;
  formVariant?: unknown;
  company?: unknown;      // honeypot
  elapsedMs?: unknown;    // client-computed render→submit milliseconds
  isTest?: unknown;
};

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');

  if (!isSupabaseServiceConfigured()) {
    return jsonResponse(origin, { error: 'Supabase service role not configured' }, 503);
  }

  let body: LeadRequestBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(origin, { error: 'Invalid JSON body' }, 400);
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const formVariant = typeof body.formVariant === 'string' ? body.formVariant.trim() : '';

  if (!name) return jsonResponse(origin, { error: 'name is required' }, 400);
  if (name.length > MAX_LEN.name) {
    return jsonResponse(origin, { error: `name must be at most ${MAX_LEN.name} characters` }, 400);
  }
  if (!email || !EMAIL_RE.test(email)) {
    return jsonResponse(origin, { error: 'A valid email is required' }, 400);
  }
  if (email.length > MAX_LEN.email) {
    return jsonResponse(origin, { error: `email must be at most ${MAX_LEN.email} characters` }, 400);
  }
  if (!phone) return jsonResponse(origin, { error: 'phone is required' }, 400);
  if (phone.length > MAX_LEN.phone) {
    return jsonResponse(origin, { error: `phone must be at most ${MAX_LEN.phone} characters` }, 400);
  }
  if (!formVariant) return jsonResponse(origin, { error: 'formVariant is required' }, 400);
  if (formVariant.length > MAX_LEN.formVariant) {
    return jsonResponse(
      origin,
      { error: `formVariant must be at most ${MAX_LEN.formVariant} characters` },
      400,
    );
  }
  // Strictly true — not merely boolean. A synced lead's 'new lead' tag enrolls
  // it in SMS drips; accepting consent:false would text a non-consenter.
  if (body.consent !== true) {
    return jsonResponse(origin, { error: 'consent is required — check the consent box to submit' }, 400);
  }
  const service: LeadService | null = asLeadService(body.service);
  if (!service) {
    return jsonResponse(
      origin,
      { error: `service must be one of: ${LEAD_SERVICES.join(', ')}` },
      400,
    );
  }

  const address = typeof body.address === 'string' && body.address.trim() ? body.address.trim() : null;
  if (address && address.length > MAX_LEN.address) {
    return jsonResponse(origin, { error: `address must be at most ${MAX_LEN.address} characters` }, 400);
  }
  const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;
  if (notes && notes.length > MAX_LEN.notes) {
    return jsonResponse(origin, { error: `notes must be at most ${MAX_LEN.notes} characters` }, 400);
  }
  const utm = sanitizeUtm(body.utm);
  const landingUrlRaw = typeof body.landingUrl === 'string' && body.landingUrl ? body.landingUrl : null;
  // Auto-populated by the client, never user-typed — truncate, don't 400 (see
  // the MAX_LEN comment above).
  const landingUrl = landingUrlRaw ? landingUrlRaw.slice(0, MAX_LEN.landingUrl) : null;
  const isTest = body.isTest === true;
  const ip = getIp(req);

  const isHoneypot = typeof body.company === 'string' && body.company.trim().length > 0;
  // elapsedMs is computed on the CLIENT (submit minus render, one clock) —
  // no cross-clock math, so device-clock skew can't fake a too-fast submit.
  // Negative / missing / non-number values fail OPEN (not spam).
  const isTooFast =
    typeof body.elapsedMs === 'number' && body.elapsedMs >= 0 && body.elapsedMs < TOO_FAST_MS;
  const isSpam = isHoneypot || isTooFast;

  const sb = getSupabaseServiceClient()!;

  const baseRow = {
    form_variant: formVariant,
    service,
    name,
    email,
    phone,
    address,
    notes,
    consent: body.consent,
    utm,
    landing_url: landingUrl,
    ip,
    is_test: isTest,
  };

  // Honeypot / too-fast: save for visibility, answer exactly like success,
  // never touch GHL — a bot must not be able to distinguish this from a real
  // submission. sync_error records WHY it was flagged (forensics — lets us
  // tell a real false-positive apart from actual bot traffic later).
  if (isSpam) {
    const spamReason = isHoneypot ? 'honeypot' : 'too_fast';
    const { error: spamErr } = await sb
      .from('website_leads')
      .insert({ ...baseRow, sync_status: 'spam', sync_error: spamReason });
    if (spamErr) console.error('[api/leads] spam-row insert failed:', spamErr.message);
    return jsonResponse(origin, { ok: true }, 200);
  }

  // Duplicate-submit dedupe: kills double-tab / network-retry dupes (a
  // visitor double-clicking submit, or a flaky connection making the client
  // retry) — the same email + service submitted again within the window is
  // answered exactly like a fresh success, without a second row or a second
  // GHL round-trip. A true millisecond-level concurrent race (two requests
  // in flight at once) is NOT closed by this check — only a DB unique index
  // would close that — accepted as rare enough not to justify a migration
  // here. Runs AFTER spam handling (spam rows must still be recorded for
  // forensics) and BEFORE rate limiting (a dedupe hit shouldn't burn the
  // submitter's rate-limit budget).
  {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { count: dupeCount, error: dupeErr } = await sb
      .from('website_leads')
      .select('id', { count: 'exact', head: true })
      .eq('email', email)
      .eq('service', service)
      .in('sync_status', ['pending', 'synced'])
      .gte('created_at', tenMinutesAgo);
    if (dupeErr) {
      console.warn('[api/leads] dedupe check failed (failing open):', dupeErr.message);
    } else if ((dupeCount ?? 0) > 0) {
      return jsonResponse(origin, { ok: true }, 200);
    }
  }

  // Rate limit: cap at 5 leads per IP per hour — the 6th submission (once 5
  // already exist) is rejected. isTest rows COUNT toward this cap — isTest
  // only marks a row for reporting/GHL-sync purposes, not a rate-limit
  // exemption; excluding it would let a live end-to-end test loop (or an
  // attacker setting isTest:true) submit past the cap for free. Same >=
  // "at limit" convention as checkRateLimit in rateLimit.ts.
  if (ip) {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error: countErr } = await sb
      .from('website_leads')
      .select('id', { count: 'exact', head: true })
      .eq('ip', ip)
      // Exclude 'partial' (abandoned-form capture) rows: this cap counts real
      // SUBMISSIONS, and POST /api/leads/partial can write several capture rows
      // per visitor. Counting them would let a normal visitor's own partial
      // captures burn down this budget and false-429 their real submit (which
      // fires from THIS route). Partial has its own separate per-IP cap.
      .not('sync_status', 'eq', 'partial')
      .gte('created_at', oneHourAgo);
    if (countErr) {
      console.warn('[api/leads] rate-limit count query failed (failing open):', countErr.message);
    } else if ((count ?? 0) >= RATE_LIMIT_MAX_PER_HOUR) {
      // A real lead caught by a shared-IP false positive (office wifi, a
      // cell carrier CGNAT) must not vanish without a trace — insert it
      // (best-effort; an insert failure still 429s) so it's recoverable.
      // This row itself counts toward FUTURE rate-limit checks (same query
      // above), so it can't be used to farm extra submissions.
      const { error: rlInsertErr } = await sb
        .from('website_leads')
        .insert({ ...baseRow, sync_status: 'rate_limited' });
      if (rlInsertErr) {
        console.error('[api/leads] rate-limited row insert failed:', rlInsertErr.message);
      }
      return jsonResponse(origin, { error: 'Too many requests — try again later.' }, 429);
    }
  }

  const { data: inserted, error: insertErr } = await sb
    .from('website_leads')
    .insert({ ...baseRow, sync_status: 'pending' })
    .select('id')
    .single<{ id: string }>();
  if (insertErr || !inserted) {
    console.error('[api/leads] insert failed:', insertErr?.message);
    return jsonResponse(origin, { error: 'Failed to save lead' }, 500);
  }

  // Phase 1 text-ops ping (2026-07-19 plan) + staff email alert: instant staff
  // heads-up for a real lead, via Telegram (routed to the 'leads' audience —
  // the audience-routing seam, so the Jobs/Inventory chats stop receiving
  // lead pings) and via email (sendLeadAlertEmail → GHL → sales@ contact).
  // Both are best-effort by contract (fail-open, no-op while unconfigured) —
  // neither may affect the lead path. Each is raced against its OWN 2s cap,
  // run concurrently via Promise.all so a slow GHL email call can't stack its
  // latency behind a slow Telegram send: these are the only notifyTelegram/
  // sendEmail calls on a CUSTOMER-facing request, and a hung API must not
  // hang a homeowner's form submit. Test leads stay silent on both.
  if (!isTest) {
    let pingTimer: ReturnType<typeof setTimeout> | undefined;
    let alertTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.all([
      Promise.race([
        notifyTelegramAudience('leads', newLeadMessage({ name, service, phone, address, baseUrl: appBaseUrl() })),
        new Promise<void>((resolve) => {
          pingTimer = setTimeout(resolve, 2000);
        }),
      ]),
      Promise.race([
        sendLeadAlertEmail(
          { name, email, phone, address, service, formVariant, notes, landingUrl },
          { partial: false },
        ),
        new Promise<void>((resolve) => {
          alertTimer = setTimeout(resolve, 2000);
        }),
      ]),
    ]);
    clearTimeout(pingTimer);
    clearTimeout(alertTimer);
  }

  // GHL sync — best effort. The row is already saved (source of truth); any
  // failure here is recorded on the row and retried later, never surfaced to
  // the customer.
  try {
    const result = await syncLeadToGhl({
      name,
      email,
      phone,
      address,
      service,
      notes,
      utm,
      landingUrl,
      formVariant,
    });
    const updatePayload: Record<string, unknown> = {
      sync_error: result.syncError ?? null,
      ghl_contact_id: result.ghlContactId ?? null,
      ghl_opportunity_id: result.ghlOpportunityId ?? null,
    };
    // status 'error' means a step AFTER the contact was created failed
    // (syncLeadToGhl caught it itself so we still have ghlContactId) — leave
    // sync_status alone so it stays 'pending' from the insert above, same as
    // the exception path below; only the forensic fields get written.
    if (result.status !== 'error') {
      updatePayload.sync_status = result.status;
    }
    const { error: updateErr } = await sb
      .from('website_leads')
      .update(updatePayload)
      .eq('id', inserted.id);
    if (updateErr) {
      console.error('[api/leads] sync-result write-back failed:', updateErr.message);
    }
  } catch (err) {
    const message = hlErrorMessage(err);
    // Redacted log line — see redactedHlErrorSummary's comment above. The
    // full message (which may embed GHL's raw response body / lead PII)
    // goes ONLY into sync_error, an RLS-locked column, never into logs.
    console.error(
      '[api/leads] GHL sync failed — row stays pending for retry:',
      redactedHlErrorSummary(err),
    );
    const { error: updateErr } = await sb
      .from('website_leads')
      .update({ sync_error: message })
      .eq('id', inserted.id);
    if (updateErr) {
      console.error('[api/leads] sync_error write-back failed:', updateErr.message);
    }
  }

  return jsonResponse(origin, { ok: true }, 200);
}
