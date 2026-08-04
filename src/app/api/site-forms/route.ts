// Non-lead website form submissions (#195).
//
// POST /api/site-forms
//
// Accepts the four marketing-site forms that are NOT sales leads: the footer
// newsletter, the newsletter page, job and intern applications, and Light Up
// For Hope nominations. These replace the orphaned Gravity Forms shortcodes
// that #152 left printing raw text on the live site.
//
// Body: JSON, or multipart/form-data when a resume is attached.
//   formType    — newsletter | careers | intern | nomination   (required)
//   formVariant — which placement, e.g. 'footer'                (required)
//   email       — required for every form
//   name, phone — required for applications and nominations
//   consent     — must be strictly true where the form requires it
//   payload     — form-specific answers (JSON string when multipart)
//   resume      — a File, applications only
//   company     — honeypot: real visitors never fill this hidden field
//   elapsedMs   — CLIENT-measured ms from render to submit; under 2s is bot-fast
//
// Response: { ok: true } on success, { error } for 400/429. Same shape as
// /api/leads so the embedded forms behave identically.
//
// WHY THIS IS NOT /api/leads: that route creates a GHL opportunity in a sales
// pipeline and applies the 'new lead' tag, which enrols the contact in SMS
// drips. Texting a newsletter subscriber or a job applicant would be wrong, so
// this route stores its own row and upserts a TAGGED CONTACT only. See
// src/lib/siteForms/siteFormService.ts.
//
// Design notes mirrored from /api/leads deliberately:
//   * the row is inserted FIRST, before any GHL call — an outage must never
//     lose a submission
//   * honeypot / too-fast submits are stored as 'spam' and answered with the
//     same 200 a real submission gets, so a bot cannot tell the difference
//   * rate limit is a DB count, so it survives cold starts and regions
//   * CORS is scoped to the two production marketing origins

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseServiceClient, isSupabaseServiceConfigured } from '@/lib/supabase';
import {
  asSiteFormType,
  requiredFieldsFor,
  syncSubmissionToGhl,
  type SiteFormType,
} from '@/lib/siteForms/siteFormService';
import {
  sendSiteFormAlertEmail,
  siteFormTelegramMessage,
  type SiteFormAlertInput,
} from '@/lib/siteForms/siteFormAlerts';
import { notifyTelegramAudience } from '@/lib/integrations/telegramRouting';

export const runtime = 'nodejs';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const TOO_FAST_MS = 2000;
const RATE_LIMIT_MAX_PER_HOUR = 5;

const MAX_LEN = {
  name: 200,
  email: 320,
  phone: 40,
  formVariant: 50,
  landingUrl: 1000,
  payloadValue: 5000,
} as const;

// Resumes only. Kept small on purpose: a serverless request body has a hard
// ceiling and a 413 surfaces to the applicant as an unexplained failure.
const RESUME_MAX_BYTES = 5 * 1024 * 1024;
const RESUME_ALLOWED = new Map<string, string>([
  ['application/pdf', 'pdf'],
  ['application/msword', 'doc'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
]);
const RESUME_BUCKET = 'applications';

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

export async function OPTIONS(req: NextRequest) {
  const origin = req.headers.get('origin');
  return new NextResponse(null, { status: 204, headers: corsHeaders(origin) });
}

type ParsedBody = {
  fields: Record<string, unknown>;
  resume: File | null;
};

async function parseBody(req: NextRequest): Promise<ParsedBody> {
  const contentType = req.headers.get('content-type') || '';
  if (contentType.includes('multipart/form-data')) {
    const form = await req.formData();
    const fields: Record<string, unknown> = {};
    let resume: File | null = null;
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') {
        fields[key] = value;
      } else if (key === 'resume') {
        resume = value;
      }
    }
    // payload arrives as a JSON string in the multipart case.
    if (typeof fields.payload === 'string') {
      try {
        fields.payload = JSON.parse(fields.payload as string);
      } catch {
        fields.payload = {};
      }
    }
    if (typeof fields.consent === 'string') fields.consent = fields.consent === 'true';
    if (typeof fields.elapsedMs === 'string') fields.elapsedMs = Number(fields.elapsedMs);
    return { fields, resume };
  }
  const json = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  return { fields: json ?? {}, resume: null };
}

function str(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/** Caps every payload value so a scripted submit cannot store megabytes of junk. */
function sanitizePayload(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') continue;
    const s = String(value).trim();
    if (s) out[key.slice(0, 60)] = s.slice(0, MAX_LEN.payloadValue);
  }
  return out;
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');

  if (!isSupabaseServiceConfigured()) {
    return jsonResponse(origin, { error: 'Submissions are not configured' }, 503);
  }

  const { fields, resume } = await parseBody(req).catch(
    () => ({ fields: {}, resume: null }) as ParsedBody,
  );

  const formType: SiteFormType | null = asSiteFormType(fields.formType);
  if (!formType) return jsonResponse(origin, { error: 'Unknown form' }, 400);

  const formVariant = str(fields.formVariant, MAX_LEN.formVariant) ?? formType;
  const email = str(fields.email, MAX_LEN.email);
  const name = str(fields.name, MAX_LEN.name);
  const phone = str(fields.phone, MAX_LEN.phone);
  const landingUrl = str(fields.landingUrl, MAX_LEN.landingUrl);
  const payload = sanitizePayload(fields.payload);
  const consent = fields.consent === true;

  if (!email || !EMAIL_RE.test(email)) {
    return jsonResponse(origin, { error: 'A valid email address is required' }, 400);
  }

  const required = requiredFieldsFor(formType);
  if (required.name && !name) return jsonResponse(origin, { error: 'Name is required' }, 400);
  if (required.phone && !phone) {
    return jsonResponse(origin, { error: 'Phone number is required' }, 400);
  }
  if (required.consent && !consent) {
    return jsonResponse(origin, { error: 'Please tick the consent box to continue' }, 400);
  }

  // Resume validation before anything is written.
  let resumeExt: string | null = null;
  if (resume) {
    if (formType !== 'careers' && formType !== 'intern') {
      return jsonResponse(origin, { error: 'This form does not accept a file' }, 400);
    }
    const ext = RESUME_ALLOWED.get(resume.type);
    if (!ext) {
      return jsonResponse(origin, { error: 'Please attach a PDF or Word document' }, 400);
    }
    if (resume.size > RESUME_MAX_BYTES) {
      return jsonResponse(origin, { error: 'That file is over 5MB, please attach a smaller one' }, 400);
    }
    resumeExt = ext;
  }

  const ip = getIp(req);
  const supabase = getSupabaseServiceClient();
  if (!supabase) {
    return jsonResponse(origin, { error: 'Submissions are not configured' }, 503);
  }

  // Bot signals. Stored, answered 200, never synced — indistinguishable to a bot.
  const honeypotTripped = typeof fields.company === 'string' && fields.company.trim() !== '';
  const elapsedMs = typeof fields.elapsedMs === 'number' ? fields.elapsedMs : null;
  const tooFast = elapsedMs !== null && Number.isFinite(elapsedMs) && elapsedMs < TOO_FAST_MS;
  const isSpam = honeypotTripped || tooFast;

  if (!isSpam && ip) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from('site_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('ip', ip)
      .gte('created_at', since);
    if ((count ?? 0) >= RATE_LIMIT_MAX_PER_HOUR) {
      return jsonResponse(origin, { error: 'Too many submissions, please try again later' }, 429);
    }
  }

  const { data: inserted, error: insertError } = await supabase
    .from('site_submissions')
    .insert({
      form_type: formType,
      form_variant: formVariant,
      name,
      email,
      phone,
      payload,
      consent,
      landing_url: landingUrl,
      ip,
      sync_status: isSpam ? 'spam' : 'pending',
    })
    .select('id')
    .single();

  if (insertError || !inserted) {
    console.error('[site-forms] insert failed:', insertError?.message);
    return jsonResponse(origin, { error: 'Something went wrong, please try again' }, 500);
  }

  if (isSpam) return jsonResponse(origin, { ok: true });

  // Resume upload AFTER the row exists, so a storage failure still leaves the
  // application itself recorded and actionable.
  let hasResume = false;
  if (resume && resumeExt) {
    const path = `${inserted.id}/resume.${resumeExt}`;
    const buffer = Buffer.from(await resume.arrayBuffer());
    const { error: upErr } = await supabase.storage
      .from(RESUME_BUCKET)
      .upload(path, buffer, { contentType: resume.type, upsert: true });
    if (upErr) {
      console.error('[site-forms] resume upload failed:', upErr.message);
    } else {
      hasResume = true;
      await supabase.from('site_submissions').update({ resume_path: path }).eq('id', inserted.id);
    }
  }

  const alertInput: SiteFormAlertInput = {
    formType,
    formVariant,
    name,
    email,
    phone,
    payload,
    hasResume,
    landingUrl,
  };

  // GHL: a tagged CONTACT and nothing else. Failure is recorded on the row and
  // never surfaced to the visitor.
  try {
    const { contactId } = await syncSubmissionToGhl({ formType, email, name, phone });
    await supabase
      .from('site_submissions')
      .update({ ghl_contact_id: contactId, sync_status: contactId ? 'synced' : 'skipped' })
      .eq('id', inserted.id);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[site-forms] GHL sync failed');
    await supabase
      .from('site_submissions')
      .update({ sync_status: 'error', sync_error: message })
      .eq('id', inserted.id);
  }

  // Staff alerts, both fail-open.
  await sendSiteFormAlertEmail(alertInput);
  await notifyTelegramAudience('leads', siteFormTelegramMessage(alertInput)).catch(() => {});

  return jsonResponse(origin, { ok: true });
}
