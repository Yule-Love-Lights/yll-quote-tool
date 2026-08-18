// Self-serve referral link request (naldo/referral-self-serve).
//
// POST /api/referrals/request-link
//
// Public, no operator auth (allowlisted in src/lib/auth/operatorGate.ts). A
// visitor types their email. If it matches an EXISTING GHL contact, we mint
// or fetch their referral code and email them the link. If it does not
// match, we do nothing. THE RESPONSE IS IDENTICAL EITHER WAY (same status,
// same body): this endpoint can never be used to test whether an email
// belongs to a YLL customer.
//
// The uniform response is a STRUCTURAL guarantee, not a timed one: the
// entire GHL lookup and match branch is scheduled with Next's after() (see
// src/app/api/estimate/route.ts for this repo's established pattern), which
// runs only once the response below has already been produced and sent.
// Nothing about the response can depend on whether a match was found,
// because the code that finds out hasn't run yet when the response is
// built, so match and no-match are indistinguishable by construction.
//
// Most of the owner's mailing list are GHL leads who never bought: no
// `customers` row, no quote. This route is deliberately narrower than
// /api/referrals/submit (the /refer/<code> landing page's lead-capture
// form): that route CREATES a new contact/lead. This one only ever acts on
// an email that ALREADY exists in GHL, and only ever sends a link email,
// never a sales tag, never an SMS enrollment.
//
// searchContacts is free-text, not exact-match (see highlevel.ts). Every
// result is re-filtered here for a normalized EXACT email match before
// anything is minted or sent.

import { NextRequest, NextResponse, after } from 'next/server';
import { rateLimitResponse, checkRateLimitByKey } from '@/lib/rateLimit';
import { searchContacts, sendEmail, upsertContactCustomField } from '@/lib/integrations/highlevel';
import { findOrCreateCustomer } from '@/lib/customers';
import { ensureReferralCode } from '@/lib/referrals';
import { appBaseUrl } from '@/lib/integrations/telegramNotify';
import { REFERRAL_LINK_EMAIL_SUBJECT, referralLinkEmailHtml } from '@/lib/integrations/quoteMessages';
import { isReferralSelfServeEnabled } from '@/lib/referralSelfServeFlag';

export const runtime = 'nodejs';
// The after() task below can fire up to five sequential GHL calls
// (searchContacts, an optional referral-link stamp on first code creation,
// sendEmail, and the two Brand Ambassador stamps), each with a 10s
// worst-case timeout (highlevel.ts GHL_TIMEOUT_MS). after() keeps the
// invocation alive only for the route's max duration, so the platform
// default would risk cutting the task off mid-chain, e.g. a code minted
// with no email sent. 60s matches this repo's convention for routes making
// several external calls (estimate, analyze-photo, analyze-address, training).
export const maxDuration = 60;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_EMAIL_LEN = 320; // mirrors MAX_LEN.email in /api/site-forms

// searchContacts is a free-text search (see highlevel.ts), clamped there to
// at most 100 results. A full email address is a fairly specific query, so
// in practice this returns very few rows, but GHL's ranking is not
// documented as exact-match-first, so a wide result set is possible for a
// common local part or domain. 100 (the maximum the function accepts) gives
// the largest practical safety margin against a genuine match sorting
// outside the window. This does not make the check exact, only wide enough
// that missing a real match this way should be rare in practice: a query on
// a full address token is not the same shape as the generic name/phone
// searches this repo's other callers use. There is no more precise,
// email-scoped lookup available in this codebase today. GHL's
// /contacts/search POST endpoint would be one, but it is unimplemented
// here, noted only as a future option in searchContacts' own comment, and
// standing up a new, unverified GHL integration is out of scope for this
// change.
const CONTACT_SEARCH_LIMIT = 100;

// Review fix 3: the outer rate limit above is per-IP, 5/60s, with no cap
// across IPs or over time, so anyone who knows an address can submit it
// repeatedly and the victim gets a fresh link email every time. This caps
// SENDING to once per normalized email per hour. In-memory (rateLimit.ts's
// own module-scoped Map), so it is per-instance and reset by a cold start:
// it raises the bar on this abuse vector, it does not close it completely.
const EMAIL_SEND_COOLDOWN_MS = 60 * 60 * 1000;

// Uniform response body and status: identical on the match and no-match
// paths.
const UNIFORM_RESPONSE = { ok: true } as const;

// Mirrors the un-exported normalizeEmailForCompare duplicated in
// src/lib/leads/leadService.ts and src/lib/leads/partialLead.ts: same
// normalization, kept local rather than importing either (neither exports
// it, and this route has no other reason to depend on the leads module).
function normalizeEmailForCompare(email: string | undefined | null): string {
  return (email ?? '').trim().toLowerCase();
}

export async function POST(req: NextRequest) {
  // Review fix 2: flag off → the whole feature is dark; 404 so it isn't even
  // advertised, before rate limiting or anything else. Mirrors
  // src/app/api/estimate/route.ts's own flag check.
  if (!isReferralSelfServeEnabled()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

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

  // Honeypot: a real visitor never fills a field they cannot see. Tripped
  // means the success response, with no lookup, mint, or send work
  // scheduled at all.
  const honeypotTripped = typeof company === 'string' && company.trim() !== '';

  // Read into a plain local before the response returns and close over that,
  // not `req` itself, inside after() below. Route Handlers may call
  // request-time APIs from inside after() (Next.js docs), so this is a style
  // choice for clarity, not a correctness requirement, kept for the same
  // reason src/app/api/estimate/route.ts does it.
  if (!honeypotTripped) {
    const emailForLookup = cleanEmail;
    after(async () => {
      try {
        await findAndSendIfMatch(emailForLookup);
      } catch (err) {
        console.error('[api/referrals/request-link] after() task failed:', err);
      }
    });
  }

  return NextResponse.json(UNIFORM_RESPONSE);
}

// Search GHL, filter for an EXACT normalized-email match, and, only on a
// match, mint or fetch the referral code and email it. Everything from the
// search onward is inside this one try/catch: every highlevel.ts function
// THROWS on a non-2xx response or a timeout, and this already runs inside
// after(), which itself catches and logs too (belt and suspenders, matching
// src/app/api/estimate/route.ts's own after() task). Any failure here
// (search, mint, or send) simply resolves to "no email sent."
async function findAndSendIfMatch(email: string): Promise<void> {
  try {
    const wantEmail = normalizeEmailForCompare(email);
    const results = await searchContacts(email, CONTACT_SEARCH_LIMIT);
    const match = results.find((c) => normalizeEmailForCompare(c.email) === wantEmail);
    if (!match) return;

    // Review fix 3: checked only on the match path, never on a no-match
    // query, so an unrelated lookup can't burn the one slot a genuine future
    // match would need. A silent skip, not a different response: the
    // uniform response above is already built and sent by the time this
    // runs, so this can't reintroduce the enumeration leak the uniform
    // response exists to prevent either way.
    const cooldown = checkRateLimitByKey(wantEmail, {
      bucket: 'referral-request-link-email-cooldown',
      limit: 1,
      windowMs: EMAIL_SEND_COOLDOWN_MS,
    });
    if (!cooldown.ok) return;

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
    // session). Awaited, not fire-and-forget: this whole function runs
    // inside after(), which extends the invocation's lifetime for exactly
    // this reason (Next.js docs, serverless waitUntil), so there is no
    // early-teardown risk here the way a bare void call on the main request
    // path would have. Each env var independently gates its own stamp;
    // unset means that stamp is skipped silently. Each stamp keeps its own
    // try/catch so one failing never prevents the other.
    await stampBrandAmbassador(match.id);
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
