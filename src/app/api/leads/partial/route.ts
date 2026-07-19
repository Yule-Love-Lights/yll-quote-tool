// Partial / abandoned-form lead capture (quote-forms-partial-save).
//
// POST /api/leads/partial
// The sibling of POST /api/leads. That route captures a COMPLETED, consented
// submission and enrolls it in GHL's SMS drips. THIS route captures whatever a
// visitor typed into a website / referral form BEFORE they finished — fired
// from the client on field-blur (debounced) and on page-leave (sendBeacon) — so
// a lead who abandons the form isn't lost.
//
// Body (tolerant of text/plain, since sendBeacon can't set application/json):
//   { captureId?, name?, email?, phone?, address?, notes?,
//     service?, formVariant?, source?, utm?, landingUrl?, isTest?, company? }
//   At least ONE usable contact handle (valid email OR a phone with >= 7
//   digits) is required; anything less is a no-op 200 (a lone name isn't a
//   lead). `captureId` is a website_leads row id returned by an earlier capture
//   in the same fill — when present we UPDATE that row instead of inserting a
//   new one, so one abandoned fill = one row, not one-per-keystroke.
//   `company` is the same honeypot as the main form.
// Response: always { ok: true, ... } with 200 — this is a background beacon; a
//   real failure is recorded on the row (source of truth) and never surfaced.
//
// The CRITICAL invariant (see partialLead.ts): a partial NEVER enters the SMS
// drips. The row is saved with sync_status 'partial' and consent false, and the
// GHL sync adds only a neutral 'partial-lead' tag — no 'new lead' tag, no
// opportunity. Consent + drip enrollment happen only via POST /api/leads.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import { isHighLevelConfigured } from '@/lib/integrations/highlevel';
import { syncPartialLeadToGhl } from '@/lib/leads/partialLead';

export const runtime = 'nodejs';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_MIN_DIGITS = 7;
// A partial fill legitimately re-POSTs several times (blur of each field + the
// page-leave beacon), but each of those UPDATEs one captureId row — only brand
// new fills INSERT. So this caps distinct abandoned fills per IP, generously
// (office wifi / CGNAT share an IP); the update path is never rate limited.
const RATE_LIMIT_MAX_INSERTS_PER_HOUR = 40;

const MAX_LEN = {
  name: 200,
  email: 320,
  phone: 40,
  address: 500,
  notes: 5000,
  service: 50,
  formVariant: 50,
  source: 50,
  captureId: 64,
  landingUrl: 1000,
} as const;

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
  const realIp = req.headers.get('x-real-ip');
  if (realIp && realIp.trim()) return realIp.trim();
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0]!.trim() || null;
  return null;
}

function str(v: unknown, maxLen: number): string {
  return typeof v === 'string' ? v.trim().slice(0, maxLen) : '';
}

function phoneDigitCount(v: string): number {
  const m = v.match(/\d/g);
  return m ? m.length : 0;
}

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get('origin');
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

type PartialBody = {
  captureId?: unknown;
  name?: unknown;
  email?: unknown;
  phone?: unknown;
  address?: unknown;
  notes?: unknown;
  service?: unknown;
  formVariant?: unknown;
  source?: unknown;
  utm?: unknown;
  landingUrl?: unknown;
  isTest?: unknown;
  company?: unknown; // honeypot
};

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');

  if (!isSupabaseServiceConfigured()) {
    // Nothing to persist to — answer OK anyway (background beacon; never surface).
    return jsonResponse(origin, { ok: true, skipped: 'no-store' }, 200);
  }

  let body: PartialBody;
  try {
    // Tolerant parse: sendBeacon posts text/plain, so we read the raw text and
    // JSON.parse it ourselves rather than trusting a content-type.
    body = JSON.parse(await req.text());
  } catch {
    return jsonResponse(origin, { ok: true, skipped: 'bad-body' }, 200);
  }
  if (!body || typeof body !== 'object') {
    return jsonResponse(origin, { ok: true, skipped: 'bad-body' }, 200);
  }

  // Honeypot: a real (invisible) field a scripted bot fills. Answer OK, save
  // nothing, touch nothing — indistinguishable to the bot.
  if (typeof body.company === 'string' && body.company.trim().length > 0) {
    return jsonResponse(origin, { ok: true }, 200);
  }

  const name = str(body.name, MAX_LEN.name);
  const email = str(body.email, MAX_LEN.email);
  const phone = str(body.phone, MAX_LEN.phone);
  const address = str(body.address, MAX_LEN.address);
  const notes = str(body.notes, MAX_LEN.notes);

  // At least one USABLE contact handle — a lone name (or junk) is not a lead.
  const hasEmail = !!email && EMAIL_RE.test(email);
  const hasPhone = phoneDigitCount(phone) >= PHONE_MIN_DIGITS;
  if (!hasEmail && !hasPhone) {
    return jsonResponse(origin, { ok: true, skipped: 'no-contact' }, 200);
  }

  const service = str(body.service, MAX_LEN.service) || 'unknown';
  const formVariant = str(body.formVariant, MAX_LEN.formVariant) || 'partial';
  const source = str(body.source, MAX_LEN.source) || 'website';
  const captureId = str(body.captureId, MAX_LEN.captureId) || null;
  const utm = sanitizeUtm(body.utm);
  const landingUrlRaw = typeof body.landingUrl === 'string' && body.landingUrl ? body.landingUrl : null;
  const landingUrl = landingUrlRaw ? landingUrlRaw.slice(0, MAX_LEN.landingUrl) : null;
  const isTest = body.isTest === true;
  const ip = getIp(req);

  const sb = getSupabaseServiceClient()!;

  // The columns are NOT NULL (email/phone/name), so absent handles are stored
  // as '' rather than requiring a schema change — a partial row legitimately
  // has only one contact handle. sync_status 'partial' keeps these rows out of
  // the retry worker (pending/deferred only) so they can never be auto-synced
  // into the drips later.
  const row = {
    form_variant: formVariant,
    service,
    name,
    email: hasEmail ? email : '',
    phone: hasPhone ? phone : '',
    address: address || null,
    notes: notes || null,
    consent: false,
    utm,
    landing_url: landingUrl,
    ip,
    is_test: isTest,
    sync_status: 'partial',
  };

  let rowId: string | null = null;

  // Update path: a captureId from an earlier blur in this same fill. Constrained
  // to sync_status='partial' so a leaked/guessed id can never mutate a real
  // pending/synced/spam lead. maybeSingle → null when the id doesn't match a
  // partial row (expired / wrong), in which case we fall through to insert.
  if (captureId) {
    const { data: updated, error: updErr } = await sb
      .from('website_leads')
      .update(row)
      .eq('id', captureId)
      .eq('sync_status', 'partial')
      .select('id')
      .maybeSingle<{ id: string }>();
    if (updErr) {
      console.warn('[api/leads/partial] update failed (falling back to insert):', updErr.message);
    } else if (updated) {
      rowId = updated.id;
    }
  }

  if (!rowId) {
    // Insert path — rate limited per IP (distinct fills only; updates above are
    // never limited). A shared-IP false positive just means we skip persisting
    // this one partial; a real completed submit still lands via POST /api/leads.
    if (ip) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count, error: countErr } = await sb
        .from('website_leads')
        .select('id', { count: 'exact', head: true })
        .eq('ip', ip)
        .eq('sync_status', 'partial')
        .gte('created_at', oneHourAgo);
      if (countErr) {
        console.warn('[api/leads/partial] rate-limit count failed (failing open):', countErr.message);
      } else if ((count ?? 0) >= RATE_LIMIT_MAX_INSERTS_PER_HOUR) {
        return jsonResponse(origin, { ok: true, skipped: 'rate-limited' }, 200);
      }
    }

    const { data: inserted, error: insErr } = await sb
      .from('website_leads')
      .insert(row)
      .select('id')
      .single<{ id: string }>();
    if (insErr || !inserted) {
      console.error('[api/leads/partial] insert failed:', insErr?.message);
      return jsonResponse(origin, { ok: true, skipped: 'insert-failed' }, 200);
    }
    rowId = inserted.id;
  }

  // Best-effort no-drip GHL sync. The row is already saved (source of truth);
  // any failure is recorded on it and never surfaced. Skipped entirely when GHL
  // isn't configured (a guaranteed throw otherwise).
  if (isHighLevelConfigured()) {
    try {
      const result = await syncPartialLeadToGhl({
        name,
        email: hasEmail ? email : null,
        phone: hasPhone ? phone : null,
        address: address || null,
        source: source === 'referral' ? 'Referral (partial)' : 'Website Form (partial)',
      });
      const { error: updErr } = await sb
        .from('website_leads')
        .update({
          ghl_contact_id: result.ghlContactId ?? null,
          sync_error: result.syncError ?? null,
        })
        .eq('id', rowId);
      if (updErr) console.error('[api/leads/partial] sync write-back failed:', updErr.message);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown HighLevel error';
      console.error('[api/leads/partial] GHL partial sync failed (row saved):', err instanceof Error ? err.name : 'error');
      const { error: updErr } = await sb
        .from('website_leads')
        .update({ sync_error: message })
        .eq('id', rowId);
      if (updErr) console.error('[api/leads/partial] sync_error write-back failed:', updErr.message);
    }
  }

  return jsonResponse(origin, { ok: true, id: rowId }, 200);
}
