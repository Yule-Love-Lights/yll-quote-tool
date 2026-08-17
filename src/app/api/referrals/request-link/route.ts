// Self-serve referral link request (naldo/referral-self-serve).
//
// POST /api/referrals/request-link
//
// Public — no operator auth (allowlisted in src/lib/auth/operatorGate.ts).
// A visitor types their email; if it matches an EXISTING GHL contact, we
// mint/fetch their referral code and email them the link. If it does not
// match, we do nothing. THE RESPONSE IS IDENTICAL EITHER WAY (same status,
// same body) so this endpoint can never be used to test whether an email
// belongs to a YLL customer. See RESPONSE_FLOOR_MS below for the other half
// of that guarantee (response TIME, not just body).
//
// Most of the owner's mailing list are GHL leads who never bought: no
// `customers` row, no quote. This route is deliberately narrower than
// /api/referrals/submit (the /refer/<code> landing page's lead-capture
// form): that route CREATES a new contact/lead; this one only ever acts on
// an email that ALREADY exists in GHL, and only ever sends a link email,
// never a sales tag, never an SMS enrollment.
//
// searchContacts is free-text, not exact-match (see highlevel.ts) — every
// result is re-filtered here for a normalized EXACT email match before
// anything is minted or sent.

import { NextRequest, NextResponse } from 'next/server';
import { rateLimitResponse } from '@/lib/rateLimit';
import { searchContacts, sendEmail, upsertContactCustomField } from '@/lib/integrations/highlevel';
import { findOrCreateCustomer } from '@/lib/customers';
import { ensureReferralCode } from '@/lib/referrals';
import { appBaseUrl } from '@/lib/integrations/telegramNotify';
import { REFERRAL_LINK_EMAIL_SUBJECT, referralLinkEmailHtml } from '@/lib/integrations/quoteMessages';

export const runtime = 'nodejs';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_EMAIL_LEN = 320; // mirrors MAX_LEN.email in /api/site-forms

// Uniform response body/status (the security property this route exists to
// hold): identical on the match and no-match paths.
const UNIFORM_RESPONSE = { ok: true } as const;

// Timing floor — the other half of the uniform-response guarantee. The
// no-match path fires exactly ONE GHL call (searchContacts). The match path
// can fire up to FIVE, sequentially: searchContacts, an optional referral-
// link custom-field stamp on first code creation (referrals.ts's
// stampReferralLinkOnContact, fired from ensureReferralCode), sendEmail, and
// the two best-effort Brand Ambassador custom-field stamps below — each with
// a 10s worst-case timeout (highlevel.ts GHL_TIMEOUT_MS). Without a floor, a
// fast no-match reply next to a slower match reply IS a timing oracle. 2.5s
// is picked comfortably above one GHL call's normal happy-path latency
// (searchContacts alone is typically a few hundred ms), so both paths
// converge on the same wall-clock time in the common case, without making a
// genuine visitor wait an unreasonable amount of time for what is otherwise
// a static confirmation screen.
const RESPONSE_FLOOR_MS = 2500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Mirrors the un-exported normalizeEmailForCompare duplicated in
// src/lib/leads/leadService.ts and src/lib/leads/partialLead.ts — same
// normalization, kept local rather than importing either (neither exports
// it, and this route has no other reason to depend on the leads module).
function normalizeEmailForCompare(email: string | undefined | null): string {
  return (email ?? '').trim().toLowerCase();
}

export async function POST(req: NextRequest) {
  const rl = rateLimitResponse(req, { bucket: 'referral-request-link', limit: 5, windowMs: 60_000 });
  if (rl) return rl;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be an object' }, { status: 400 });
  }

  const { email, company } = body as Record<string, unknown>;

  const cleanEmail = typeof email === 'string' ? email.trim().slice(0, MAX_EMAIL_LEN) : '';
  if (!cleanEmail || !EMAIL_RE.test(cleanEmail)) {
    return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 });
  }

  // Honeypot: a real visitor never fills a field they cannot see. Tripped ⇒
  // the success response, with no lookup/mint/send work done at all.
  const honeypotTripped = typeof company === 'string' && company.trim() !== '';

  const doWork = honeypotTripped ? Promise.resolve() : findAndSendIfMatch(cleanEmail);
  // The floor runs CONCURRENTLY with the real work, not after it — this is
  // what makes the wall-clock time converge instead of merely adding a fixed
  // delay on top of whatever the match/no-match branch already took.
  await Promise.all([doWork, sleep(RESPONSE_FLOOR_MS)]);

  return NextResponse.json(UNIFORM_RESPONSE);
}

// Search GHL, filter for an EXACT normalized-email match, and — only on a
// match — mint/fetch the referral code and email it. Everything from the
// search onward is inside this one try/catch: every highlevel.ts function
// THROWS on a non-2xx/timeout, and an uncaught throw here would 500 ONLY on
// a request that reached this function — which would itself leak that GHL
// was queried at all. Any failure (search, mint, or send) simply resolves to
// "no email sent," the same outward result as a genuine no-match.
async function findAndSendIfMatch(email: string): Promise<void> {
  try {
    const wantEmail = normalizeEmailForCompare(email);
    const results = await searchContacts(email, 20);
    const match = results.find((c) => normalizeEmailForCompare(c.email) === wantEmail);
    if (!match) return;

    const name =
      match.fullName?.trim() || [match.firstName, match.lastName].filter(Boolean).join(' ').trim() || null;
    const customer = await findOrCreateCustomer({
      hl_contact_id: match.id,
      email: match.email ?? email,
      name,
      phone: match.phone ?? null,
    });
    if (!customer) return;

    const code = await ensureReferralCode(customer.id);
    if (!code) return;

    const referralUrl = `${appBaseUrl()}/refer/${code}`;
    await sendEmail({
      contactId: match.id,
      subject: REFERRAL_LINK_EMAIL_SUBJECT,
      html: referralLinkEmailHtml({ firstName: match.firstName ?? null, referralUrl }),
    });

    // Best-effort Brand Ambassador enrollment stamps (owner-approved this
    // session) — never block or fail the response, same fail-open contract
    // (and same fire-and-forget shape) as referrals.ts's
    // stampReferralLinkOnContact. Each env var independently gates its own
    // stamp; unset means that stamp is skipped silently.
    void stampBrandAmbassador(match.id);
  } catch (err) {
    console.error('[api/referrals/request-link] match lookup/send failed:', err);
  }
}

async function stampBrandAmbassador(contactId: string): Promise<void> {
  const statusFieldId = process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_STATUS;
  if (statusFieldId) {
    try {
      await upsertContactCustomField(contactId, statusFieldId, 'Active');
    } catch (err) {
      console.error('[api/referrals/request-link] brand ambassador status stamp failed:', err);
    }
  }
  const dateFieldId = process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_ENROLLMENT_DATE;
  if (dateFieldId) {
    try {
      await upsertContactCustomField(contactId, dateFieldId, new Date().toISOString());
    } catch (err) {
      console.error('[api/referrals/request-link] brand ambassador enrollment date stamp failed:', err);
    }
  }
}
