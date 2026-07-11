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
//   consent: boolean                            — required
//   company?     — honeypot: real visitors never fill this hidden field
//   renderedAt?  — client ISO timestamp for when the form rendered, used
//                  to catch bot submits that fire faster than a human can type
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
  renderedAt?: unknown;   // client timestamp the form rendered
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
  if (!email || !EMAIL_RE.test(email)) {
    return jsonResponse(origin, { error: 'A valid email is required' }, 400);
  }
  if (!phone) return jsonResponse(origin, { error: 'phone is required' }, 400);
  if (!formVariant) return jsonResponse(origin, { error: 'formVariant is required' }, 400);
  if (typeof body.consent !== 'boolean') {
    return jsonResponse(origin, { error: 'consent must be true or false' }, 400);
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
  const notes = typeof body.notes === 'string' && body.notes.trim() ? body.notes.trim() : null;
  const utm =
    body.utm && typeof body.utm === 'object' && !Array.isArray(body.utm)
      ? (body.utm as Record<string, string>)
      : null;
  const landingUrl = typeof body.landingUrl === 'string' && body.landingUrl ? body.landingUrl : null;
  const isTest = body.isTest === true;
  const ip = getIp(req);

  const isHoneypot = typeof body.company === 'string' && body.company.trim().length > 0;
  const renderedAtMs = typeof body.renderedAt === 'string' ? Date.parse(body.renderedAt) : NaN;
  const isTooFast = !Number.isNaN(renderedAtMs) && Date.now() - renderedAtMs < TOO_FAST_MS;
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
