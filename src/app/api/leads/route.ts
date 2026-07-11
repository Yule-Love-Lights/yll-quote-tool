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
//                 Under 3s = bot-fast. Never a raw client timestamp compared
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

export const runtime = 'nodejs';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TOO_FAST_MS = 3000;
const RATE_LIMIT_MAX_PER_HOUR = 5;

// Max lengths per field — anything over is a 400 (a real form never produces
// these; only scripted junk does). Email's 320 is the RFC-side ceiling.
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
  const landingUrl = typeof body.landingUrl === 'string' && body.landingUrl ? body.landingUrl : null;
  if (landingUrl && landingUrl.length > MAX_LEN.landingUrl) {
    return jsonResponse(
      origin,
      { error: `landingUrl must be at most ${MAX_LEN.landingUrl} characters` },
      400,
    );
  }
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
  // submission.
  if (isSpam) {
    const { error: spamErr } = await sb
      .from('website_leads')
      .insert({ ...baseRow, sync_status: 'spam' });
    if (spamErr) console.error('[api/leads] spam-row insert failed:', spamErr.message);
    return jsonResponse(origin, { ok: true }, 200);
  }

  // Rate limit: cap at 5 leads per IP per hour — the 6th submission (once 5
  // already exist) is rejected. Test rows excluded, mirroring the is_test
  // exclusion pattern in customers.ts. Same >= "at limit" convention as
  // checkRateLimit in rateLimit.ts.
  if (ip) {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count, error: countErr } = await sb
      .from('website_leads')
      .select('id', { count: 'exact', head: true })
      .eq('ip', ip)
      .not('is_test', 'is', true)
      .gte('created_at', oneHourAgo);
    if (countErr) {
      console.warn('[api/leads] rate-limit count query failed (failing open):', countErr.message);
    } else if ((count ?? 0) >= RATE_LIMIT_MAX_PER_HOUR) {
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
    const { error: updateErr } = await sb
      .from('website_leads')
      .update({
        sync_status: result.status,
        sync_error: result.syncError ?? null,
        ghl_contact_id: result.ghlContactId ?? null,
        ghl_opportunity_id: result.ghlOpportunityId ?? null,
      })
      .eq('id', inserted.id);
    if (updateErr) {
      console.error('[api/leads] sync-result write-back failed:', updateErr.message);
    }
  } catch (err) {
    const message = hlErrorMessage(err);
    console.error('[api/leads] GHL sync failed — row stays pending for retry:', message);
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
