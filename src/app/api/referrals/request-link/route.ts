// Self-serve referral link request (naldo/referral-self-serve +
// naldo/referral-link-personalized).
//
// POST /api/referrals/request-link
//
// Public, no operator auth (allowlisted in src/lib/auth/operatorGate.ts).
// Two independent ways in, each with its OWN threat model, each responding
// differently on purpose:
//
// 1) { email }: a visitor types their email. If it matches an EXISTING GHL
//    contact, we mint or fetch their referral code and email them the link.
//    If it does not match, we do nothing. THE RESPONSE IS IDENTICAL EITHER
//    WAY (same status, same body): this path can never be used to test
//    whether an email belongs to a YLL customer, because an email address
//    IS guessable. The uniform response is a STRUCTURAL guarantee, not a
//    timed one: the entire GHL lookup and match branch is scheduled with
//    Next's after() (see src/app/api/estimate/route.ts for this repo's
//    established pattern), which runs only once the response below has
//    already been produced and sent. Nothing about the response can depend
//    on whether a match was found, because the code that finds out hasn't
//    run yet when the response is built, so match and no-match are
//    indistinguishable by construction.
//
// 2) { contactId }: the owner emails his whole GHL list, and GoHighLevel
//    can merge each recipient's OWN contact id into the link
//    (/referral-link?c=<id>), so the page never has to ask them to type
//    anything. Unlike the email path, a successful lookup here returns the
//    referral URL in the response body so the page can show it immediately,
//    and this is deliberately NOT scheduled with after(): the response
//    itself depends on the lookup's result, so it is awaited inline,
//    still within this route's maxDuration budget.
//
//    Why returning the link here is safe: possessing a valid GoHighLevel
//    contact id already means you ARE that contact, because the id only
//    ever reaches a real person through a merge field GoHighLevel
//    substitutes into an email addressed to them. GHL contact ids are long,
//    non-sequential, random-looking strings, not enumerable the way an
//    email address is guessable, so handing back a result keyed on one is
//    not a practical oracle. Two different threat models, two different
//    behaviours, on purpose: the email path stays uniform and timing-safe
//    because the KEY (an email) is guessable; the contact-id path can
//    answer directly because the key is not.
//
// Most of the owner's mailing list are GHL leads who never bought: no
// `customers` row, no quote. This route is deliberately narrower than
// /api/referrals/submit (the /refer/<code> landing page's lead-capture
// form): that route CREATES a new contact/lead. This one only ever acts on
// a contact that ALREADY exists in GHL, and only ever sends a link email,
// never a sales tag, never an SMS enrollment.
//
// searchContacts (email path) is free-text, not exact-match (see
// highlevel.ts). Every result is re-filtered here for a normalized EXACT
// email match before anything is minted or sent. getContact (contact-id
// path) is a direct id lookup, no fuzzy matching involved, and throws on a
// non-2xx (a bogus or stale id lands in a catch, indistinguishable from a
// real GHL outage, same as a no-match on the email path).

import { NextRequest, NextResponse, after } from 'next/server';
import { rateLimitResponse, checkRateLimitByKey, checkRateLimit } from '@/lib/rateLimit';
import { searchContacts, sendEmail, upsertContactCustomField, getContact } from '@/lib/integrations/highlevel';
import type { CrmContact } from '@/lib/integrations/types';
import { findOrCreateCustomer } from '@/lib/customers';
import { ensureReferralCode, hasReferralCode } from '@/lib/referrals';
import { appBaseUrl } from '@/lib/integrations/telegramNotify';
import { REFERRAL_LINK_EMAIL_SUBJECT, referralLinkEmailHtml } from '@/lib/integrations/quoteMessages';
import { isReferralSelfServeEnabled } from '@/lib/referralSelfServeFlag';
import { ingestTouch } from '@/lib/dashboard/inbox/store';

export const runtime = 'nodejs';
// The after() task below can fire up to five GHL calls total (searchContacts,
// sendEmail, and the two Brand Ambassador stamps run directly in sequence
// here; an optional referral-link stamp on first code creation is scheduled
// separately, from inside ensureReferralCode, via its OWN nested after() call,
// review fix 8), each with a 10s worst-case timeout (highlevel.ts
// GHL_TIMEOUT_MS). Every one of them is covered by SOME after()'s
// invocation-lifetime extension, so the platform default would risk cutting
// one off mid-chain, e.g. a code minted with no email sent. 60s matches this
// repo's convention for routes making several external calls (estimate,
// analyze-photo, analyze-address, training).
export const maxDuration = 60;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_EMAIL_LEN = 320; // mirrors MAX_LEN.email in /api/site-forms
// naldo/referral-link-personalized: GHL contact ids are short opaque
// strings (no documented format in this codebase), this just keeps an
// obviously-garbage body from being carried any further than necessary.
const MAX_CONTACT_ID_LEN = 100;

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
// paths for the email path, and reused as the contact-id path's fallback
// too (no match, an honeypot trip, or any failure), since that path never
// confirms or denies a bad id either.
const UNIFORM_RESPONSE = { ok: true } as const;

// Delta-verify fix A: per-IP ceiling on the staff-record path. See the
// comment at its use site in POST for why this exists and why 20 is the
// number.
const INGEST_CAP_PER_IP_PER_HOUR = 20;
const INGEST_CAP_WINDOW_MS = 60 * 60 * 1000;

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

  const { email, contactId, company } = body as Record<string, unknown>;

  // naldo/referral-link-personalized: the two paths are mutually exclusive.
  // The client only ever sends one shape (see ReferralLinkForm.tsx), so a
  // body carrying both is either a caller bug or a probe, rejected before
  // either path's own logic runs. cleanContactId is computed the same way
  // cleanEmail below always has been (typeof-guarded, trimmed, length-
  // capped), so it is TS-narrowed to a real string from this point on and
  // truthy only when a non-empty contactId was actually sent.
  const cleanContactId = typeof contactId === 'string' ? contactId.trim().slice(0, MAX_CONTACT_ID_LEN) : '';
  const hasEmailField = typeof email === 'string' && email.trim() !== '';
  if (cleanContactId && hasEmailField) {
    return NextResponse.json({ error: 'Send either an email or a contactId, not both' }, { status: 400 });
  }

  // Honeypot: a real visitor never fills a field they cannot see. Tripped
  // means the success response, with no lookup, mint, or send work
  // scheduled at all. Shared by both paths below.
  const honeypotTripped = typeof company === 'string' && company.trim() !== '';

  // ─── Contact-id path (naldo/referral-link-personalized) ──────────────────
  // See the file header comment for the full two-threat-model reasoning.
  // Awaited inline, on purpose: this path's response depends on the
  // lookup's result, unlike the email path below, which schedules
  // everything with after() and never lets the response wait on GHL at all.
  if (cleanContactId) {
    // Same treatment as the email path's own honeypot trip: the generic
    // fallback response, no lookup at all.
    if (honeypotTripped) {
      return NextResponse.json(UNIFORM_RESPONSE);
    }

    let referralUrl: string | null = null;
    try {
      referralUrl = await findAndSendForContactId(cleanContactId);
    } catch (err) {
      console.error('[api/referrals/request-link] contact-id path failed:', err);
    }
    return referralUrl ? NextResponse.json({ ok: true, referralUrl }) : NextResponse.json(UNIFORM_RESPONSE);
  }

  // ─── Email path (unchanged from naldo/referral-self-serve) ───────────────
  const cleanEmail = typeof email === 'string' ? email.trim().slice(0, MAX_EMAIL_LEN) : '';
  if (!cleanEmail || !EMAIL_RE.test(cleanEmail)) {
    return NextResponse.json({ error: 'A valid email address is required' }, { status: 400 });
  }

  // Read into a plain local before the response returns and close over that,
  // not `req` itself, inside after() below. Route Handlers may call
  // request-time APIs from inside after() (Next.js docs), so this is a style
  // choice for clarity, not a correctness requirement, kept for the same
  // reason src/app/api/estimate/route.ts does it.
  if (!honeypotTripped) {
    const emailForLookup = cleanEmail;

    // Delta-verify fix A: cap the staff-record path per client IP.
    //
    // recordRequestForStaff below runs for EVERY request that reaches this
    // block, matched or not, and that symmetry is deliberate (see its own
    // comment): a write that happened only on a match would hand anyone
    // with dashboard access a match oracle. But ingestTouch INSERTs a
    // dashboard_contacts row whenever the submitted email matches no
    // existing contact, so distinct garbage emails each mint a permanent
    // row. The outer 5-per-60s limit allows roughly 300 rows an hour per
    // IP, which is not a cap in any useful sense.
    //
    // Computed here, inside the honeypot guard and before the response, so
    // the boolean can be closed over rather than re-deriving it from `req`
    // inside after(), and so a honeypot trip never spends a slot of this
    // budget it will never use: recordRequestForStaff already never runs
    // for a tripped request, whether or not this check would have passed.
    // A silent skip either way: it never touches the response, so it
    // cannot reintroduce the enumeration leak. 20 an hour is far above real
    // use (one request per person, and a household or small office shares
    // one IP) while cutting the worst case by roughly 15x.
    const mayRecord = checkRateLimit(req, {
      bucket: 'referral-link-ingest',
      limit: INGEST_CAP_PER_IP_PER_HOUR,
      windowMs: INGEST_CAP_WINDOW_MS,
    }).ok;

    after(async () => {
      try {
        await findAndSendIfMatch(emailForLookup);
      } catch (err) {
        console.error('[api/referrals/request-link] after() task failed:', err);
      }
      if (mayRecord) {
        try {
          await recordRequestForStaff(emailForLookup);
        } catch (err) {
          console.error('[api/referrals/request-link] inbox ingest failed:', err);
        }
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

    // naldo/referral-link-personalized: the mint-and-send tail below is now
    // shared with the contact-id path (mintAndSendReferralLink). Both
    // arguments here are byte-identical to what this function computed
    // inline before that split (verified against route.test.ts, which
    // still passes unchanged): `match.email ?? email` is kept exactly as it
    // was, even though the exact-match filter above already guarantees
    // match.email is never nullish in practice, and the cooldown key is
    // still the normalized email, unchanged.
    await mintAndSendReferralLink({
      match,
      emailForCustomer: match.email ?? email,
      cooldownKey: wantEmail,
    });
  } catch (err) {
    console.error('[api/referrals/request-link] match lookup/send failed:', err);
  }
}

// naldo/referral-link-personalized: fetch ONE contact by id (no fuzzy
// search involved, unlike the email path above) and hand off to the same
// mint-and-send tail. Returns the referral URL on success, or null on
// anything else (id does not resolve, GHL errors, cooldown active,
// customer/code could not be resolved), so the caller falls back to the
// same generic response the email path uses either way, never confirming
// or denying that an id is real.
async function findAndSendForContactId(contactId: string): Promise<string | null> {
  try {
    const match = await getContact(contactId);
    return await mintAndSendReferralLink({
      match,
      emailForCustomer: match.email ?? null,
      // Keyed on the contact id itself, not an email string: this path
      // always has an id (that's the lookup key), but a GHL contact is not
      // guaranteed to carry an email on file. The prefix keeps this
      // bucket's keyspace visibly distinct from the email path's
      // normalized-email keys, though the two could never collide in
      // practice (an email always contains "@", a GHL id never does).
      cooldownKey: `contact:${match.id}`,
    });
  } catch (err) {
    console.error('[api/referrals/request-link] contact-id lookup/send failed:', err);
    return null;
  }
}

// Shared tail for both paths above: given an already-resolved GHL contact
// and a cooldown key appropriate to how it was found, mints or fetches the
// referral code, sends the link email, and applies the Brand Ambassador
// stamps. Returns the referral URL on success, or null the moment any step
// can't complete (cooldown active, no customer, no code); the caller
// decides what null means for its own response.
async function mintAndSendReferralLink(input: {
  match: CrmContact;
  emailForCustomer: string | null;
  cooldownKey: string;
}): Promise<string | null> {
  const { match, emailForCustomer, cooldownKey } = input;

  // Review fix 3 (naldo/referral-self-serve): checked before any write, so
  // an unrelated lookup or a second click can't burn the one slot a genuine
  // send needs. A silent skip, not a different response: on the email path
  // the uniform response is already built and sent by the time this runs;
  // on the contact-id path, a cooldown hit falls back to that same generic
  // response, so this can't reintroduce the enumeration leak either way.
  const cooldown = checkRateLimitByKey(cooldownKey, {
    bucket: 'referral-request-link-email-cooldown',
    limit: 1,
    windowMs: EMAIL_SEND_COOLDOWN_MS,
  });
  if (!cooldown.ok) return null;

  const name =
    match.fullName?.trim() || [match.firstName, match.lastName].filter(Boolean).join(' ').trim() || null;
  // Review fix 5 (naldo/referral-self-serve): skipIdentityRefresh true.
  // Both callers are anonymous/unauthenticated (a typed email, or a contact
  // id lifted from an email merge field), so neither should ever let a
  // stale GHL field overwrite a more recently corrected stored record on
  // demand. Creating a new row when none exists is unaffected.
  const customer = await findOrCreateCustomer(
    {
      hl_contact_id: match.id,
      email: emailForCustomer,
      name,
      phone: match.phone ?? null,
    },
    { skipIdentityRefresh: true },
  );
  if (!customer) return null;

  // Review fix 4 (naldo/referral-self-serve): read BEFORE minting, so
  // "false" means ensureReferralCode below is about to create a code that
  // didn't exist a moment ago (a genuine first enrollment). Used only to
  // gate the enrollment-date stamp further down, see hasReferralCode's own
  // doc comment for why a same-customer race is closed and what narrower
  // window remains.
  const isFirstEnrollment = !(await hasReferralCode(customer.id));

  const code = await ensureReferralCode(customer.id);
  if (!code) return null;

  const referralUrl = `${appBaseUrl()}/refer/${code}`;
  await sendEmail({
    contactId: match.id,
    subject: REFERRAL_LINK_EMAIL_SUBJECT,
    html: referralLinkEmailHtml({ firstName: match.firstName ?? null, referralUrl }),
  });

  // Best-effort Brand Ambassador enrollment stamps (owner-approved this
  // session). Awaited, not fire-and-forget: the email path's caller runs
  // this whole chain inside after(), which extends the invocation's
  // lifetime for exactly this reason (Next.js docs, serverless waitUntil).
  // The contact-id path's caller awaits this function directly inline
  // instead (no after() involved there), so there is no early-teardown
  // risk on that path either. Each env var independently gates its own
  // stamp; unset means that stamp is skipped silently. Each stamp keeps its
  // own try/catch so one failing never prevents the other.
  await stampBrandAmbassador(match.id, isFirstEnrollment);
  return referralUrl;
}

// Review fix 6: best-effort inbox touch so staff have a record that a link
// was requested, mirroring src/app/api/referrals/submit/route.ts's own
// ingestTouch call. Recorded for EVERY request (match or not, sent or not):
// a no-match is a normal outcome, not a failure, and must stay invisible for
// the same enumeration reasons the uniform response exists for, but this is
// a purely internal, staff-only record that never varies the HTTP response,
// so recording it can't reintroduce that leak.
//
// leadKind: 'automated', verified (not assumed) against store.ts: totalLeads
// subtracts an 'automated' window count, and listEscalatableItems' own
// `.or('lead_kind.is.null,lead_kind.neq.automated')` filter excludes
// 'automated' rows outright. So this can't inflate the staff lead count or
// fire an amber/red escalation alert the way a genuine new lead would, even
// if the owner's whole list produces hundreds of these in one blast.
//
// externalId is keyed on the normalized email (not per-submission), so a
// repeat request from the same visitor updates one inbox item instead of
// piling up a new one per resubmission.
async function recordRequestForStaff(email: string): Promise<void> {
  await ingestTouch(
    {
      source: 'quotetool',
      externalId: `referral-link-request:${normalizeEmailForCompare(email)}`,
      sourceMessageId: null,
      direction: 'inbound',
      channel: null,
      lastMessageAt: new Date(),
      preview: email,
      subject: 'Referral link requested',
      identity: {
        emails: [email],
        phones: [],
        displayName: null,
      },
      leadKind: 'automated',
    },
    new Date(),
  );
}

// Review fix 4: `isFirstEnrollment` gates the ENROLLMENT DATE only. Status
// keeps stamping 'Active' unconditionally on every match. That value is
// idempotent (writing 'Active' again when it's already 'Active' changes
// nothing), while the date previously meant "last time anyone submitted
// this email" instead of "when they enrolled": every resubmission silently
// overwrote it, with no bulk-undo available in the app.
async function stampBrandAmbassador(contactId: string, isFirstEnrollment: boolean): Promise<void> {
  const statusFieldId = process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_STATUS;
  if (statusFieldId) {
    try {
      await upsertContactCustomField(contactId, statusFieldId, 'Active');
    } catch (err) {
      console.error('[api/referrals/request-link] brand ambassador status stamp failed:', err);
    }
  }
  const dateFieldId = process.env.HIGHLEVEL_CONTACT_FIELD_BRAND_AMBASSADOR_ENROLLMENT_DATE;
  if (dateFieldId && isFirstEnrollment) {
    try {
      await upsertContactCustomField(contactId, dateFieldId, new Date().toISOString());
    } catch (err) {
      console.error('[api/referrals/request-link] brand ambassador enrollment date stamp failed:', err);
    }
  }
}
