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
import { checkRateLimitByKey } from '@/lib/rateLimit';

export const runtime = 'nodejs';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_MIN_DIGITS = 7;
// A partial fill legitimately re-POSTs several times (blur of each field + the
// page-leave beacon), but each of those UPDATEs one captureId row — only brand
// new fills INSERT. So this caps distinct abandoned FILLS per IP, generously
// (office wifi / CGNAT share an IP).
const RATE_LIMIT_MAX_INSERTS_PER_HOUR = 40;
// ...and this caps CALLS per IP, which the row cap above cannot: an UPDATE
// creates no row, so a row-count limit never sees the update path at all. That
// mattered because every accepted call (spam row, update, insert alike) writes
// to the DB, and the non-honeypot paths also drive a full GHL contact upsert —
// and the response hands the caller its own row id, which is exactly the
// captureId needed to re-enter the update path indefinitely. Without a call cap
// one id was an unlimited ticket to mint GHL contacts against a per-location
// quota shared with the real lead pipeline and the dashboard crons. A genuine
// abandoned fill is ~5 calls (four field blurs + the page-leave beacon), so 120
// leaves ~24 fills/hour on a shared IP. In-memory + per-region like every other
// user of this helper: a budget guardrail, not DoS protection.
const RATE_LIMIT_MAX_CALLS_PER_HOUR = 120;

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

  // Honeypot: a hidden field only a bot (or an over-eager password manager)
  // fills. Unlike the main route's early-return-and-drop, we DON'T discard it
  // on the floor here — a partial fires on blur mid-fill, so an autofill false
  // positive is more likely, and silently dropping it would lose the very lead
  // this feature exists to keep. Handled AFTER the row is built (below): saved
  // as a 'spam' row for a forensic/recovery trace, and never synced to GHL.
  const isHoneypot = typeof body.company === 'string' && body.company.trim().length > 0;

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

  // Per-IP CALL budget. Deliberately ahead of every write below (spam row,
  // captureId update, insert) so no path is unmetered — see
  // RATE_LIMIT_MAX_CALLS_PER_HOUR for why the row-count cap further down cannot
  // cover the update path. Answers like every other skip here (200 + ok:true, no
  // 429): this is a background beacon and must never surface anything to the
  // visitor. Keyed on THIS route's getIp (x-real-ip first) rather than the
  // limiter module's own helper, which prefers the client-settable
  // x-forwarded-for.
  if (ip) {
    const rl = checkRateLimitByKey(ip, {
      limit: RATE_LIMIT_MAX_CALLS_PER_HOUR,
      windowMs: 60 * 60 * 1000,
      bucket: 'leads-partial',
    });
    if (!rl.ok) return jsonResponse(origin, { ok: true, skipped: 'rate-limited' }, 200);
  }

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

  // Honeypot hit that still carried a usable contact handle (we already
  // returned above when there was none): save it as 'spam' so a real
  // password-manager false positive stays recoverable in /admin/leads, and
  // never touch GHL. Answers exactly like a success — indistinguishable to a bot.
  if (isHoneypot) {
    const { error: spamErr } = await sb
      .from('website_leads')
      .insert({ ...row, sync_status: 'spam', sync_error: 'honeypot' });
    if (spamErr) console.error('[api/leads/partial] spam-row insert failed:', spamErr.message);
    return jsonResponse(origin, { ok: true }, 200);
  }

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
    // Insert path — capped per IP by DISTINCT FILLS (the call cap above governs
    // request volume). A shared-IP false positive just means we skip persisting
    // this one partial; a real completed submit still lands via POST /api/leads.
    // Counts 'spam' rows as well as 'partial': they are written by the honeypot
    // branch above, so excluding them made tripping the bot trap the cheaper way
    // in — a bot got an uncapped insert channel while an honest visitor was
    // capped.
    if (ip) {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count, error: countErr } = await sb
        .from('website_leads')
        .select('id', { count: 'exact', head: true })
        .eq('ip', ip)
        .in('sync_status', ['partial', 'spam'])
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
  } else {
    // Record WHY the row has no GHL contact/tag, so a missing-config state is
    // visible in /admin/leads instead of an unexplained untagged partial row.
    const { error: updErr } = await sb
      .from('website_leads')
      .update({ sync_error: 'HighLevel not configured' })
      .eq('id', rowId);
    if (updErr) console.error('[api/leads/partial] config-skip write-back failed:', updErr.message);
  }

  return jsonResponse(origin, { ok: true, id: rowId }, 200);
}
