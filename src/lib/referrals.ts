// Referral program, PR 1 (ledger #41). Locked product (Naldo, S30; reward
// widened S72, 2026-08-28): the referrer earns a $125 credit per booked
// friend, good toward ANY Yule Love Lights service (holiday, permanent,
// event, bistro) — not next season only. Stackable: one credit per friend
// who books, no cap. The friend gets two free 16" spritzers
// on their first booked install; the redemption UI that actually SPENDS a
// credit is PR 2 — this file only owns the constants + the accrual data path.
//
// Schema: migrations/2026-07-10-referrals.sql. Service-role only (RLS enabled,
// no policies — same model as customers/properties).
//
// Attribution is BOTH ways (see the migration header for the full rationale):
//   'link'    — the referrer's personal /refer/<code> page. referee_quote_id
//               is NULL at creation (a lead capture, before any quote exists).
//   'mention' — staff picks an existing customer as "Referred by" while
//               building a NEW quote; referee_quote_id is that quote's id,
//               known immediately.
// accrueOnBooking only ever matches on referee_quote_id, so a 'link' row
// can't double-credit — it stays pending until a real quote (a 'mention' row)
// exists for that lead and gets booked.

import { after } from 'next/server';
import { cache } from 'react';
import { getSupabaseServiceClient } from './supabase';
import { randomBytes } from 'crypto';
import { upsertContactCustomField, isHighLevelConfigured, sendSms, sendEmail } from './integrations/highlevel';
import { appBaseUrl } from './integrations/telegramNotify';
import { REFERRAL_EARNED_EMAIL_SUBJECT, referralEarnedEmailHtml, referralEarnedSmsBody } from './integrations/quoteMessages';
import { normalizePhone } from './customers';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Credit a referrer earns per booked friend (USD). Spendable on ANY
 *  service, not next season only (widened S72, 2026-08-28). */
export const REFERRAL_CREDIT_USD = 125;

/** A booked credit expires this many years after the friend's booking
 *  (Naldo locked, #41 follow-up — see migrations/2026-07-11-referral-credit-expiry.sql). */
export const REFERRAL_CREDIT_EXPIRY_YEARS = 2;

/** What the referred friend gets on their first booked install. */
export const REFERRAL_FRIEND_SPRITZERS = { count: 2, sizeInches: 16 } as const;

/** The friend's cash alternative to the spritzers. Defined in the
 *  client-safe module (client components state this offer too) and
 *  re-exported here so server callers get every referral constant from one
 *  import. See referralSpritzerValue.ts for the reasoning and the $150 vs
 *  $170 distinction. */
export { REFERRAL_FRIEND_ALT_CREDIT_USD } from './referralSpritzerValue';

/** The env var backing the GHL contact custom field that carries the
 *  referrer's personal link (so a workflow can merge {{contact.referral_link}}).
 *  Unset ⇒ the stamp is skipped (mirrors quoteLinkFieldId's fail-open contract).
 *  Exported (naldo/referral-link-sweep) so the referral sweep can resolve the
 *  SAME field id for its idempotency check (reading a contact's own
 *  customFields) without duplicating the env var name a second place. */
export const REFERRAL_LINK_FIELD_ENV = 'HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK';

export type ReferralSource = 'link' | 'mention';
export type ReferralStatus = 'pending' | 'booked' | 'credited';

export type ReferralRow = {
  id: string;
  referrer_customer_id: string | null;
  referee_quote_id: string | null;
  referee_contact_name: string | null;
  referee_contact_email: string | null;
  referee_contact_phone: string | null;
  source: ReferralSource;
  status: ReferralStatus;
  amount_usd: number;
  booked_at: string | null;
  /** Stamped by accrueOnBooking = booked_at + REFERRAL_CREDIT_EXPIRY_YEARS.
   *  NULL means non-expiring (grandfathered — booked before this column
   *  existed, or still 'pending'). See isReferralSpendable. */
  expires_at: string | null;
  // Redemption (PR 2): when + on which (spending) quote this row's credit was
  // consumed. Both null until status flips to 'credited' (consumeCredits).
  credited_at: string | null;
  credited_quote_id: string | null;
  created_at: string;
  updated_at: string;
};

function svc() {
  return getSupabaseServiceClient();
}

// ─── Code generation ────────────────────────────────────────────────────────

// Crockford Base32 alphabet (32 symbols) — drops the visually-ambiguous
// I/L/O and the profanity-prone U, so a code read aloud or typo'd by hand is
// unambiguous. One random byte per character, `byte % 32`: 256 is an exact
// multiple of 32, so this mapping is perfectly uniform — no modulo bias.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;

/** Generate one short, URL-safe referral code (8 chars). Not guaranteed unique
 *  by itself — callers retry on a DB collision (see ensureReferralCode). */
export function generateReferralCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

const MAX_CODE_GEN_ATTEMPTS = 5;

// ─── Ensure / lookup ────────────────────────────────────────────────────────

/**
 * Review fix 4: cheap pre-check for a caller that needs to know, BEFORE
 * calling ensureReferralCode, whether this would be a first-time mint. Reads
 * the exact same column ensureReferralCode itself checks below
 * (`if (existing.referral_code) return existing.referral_code;`), so "false"
 * here lines up exactly with "ensureReferralCode is about to mint a new
 * code" there. A separate read rather than widening ensureReferralCode's own
 * return shape, so its 7+ existing callers (the portal approved page, the
 * customer dashboard panel, three webhook/job routes) are unaffected.
 *
 * Not atomic by itself (this read and the later ensureReferralCode call are
 * two separate round-trips), but for its one current caller (POST
 * /api/referrals/request-link) the obvious risk, a same-email double
 * submission, is already closed: a per-normalized-email cooldown
 * (checkRateLimitByKey) runs synchronously, with no await of its own,
 * before this is ever reached, so only one request per MATCHED GoHighLevel
 * contact can ever get past the cooldown. A match requires the submitted
 * email to equal that contact's own stored email exactly, so two requests
 * that share a contact always share a cooldown key too, and the loser
 * returns before reaching here.
 *
 * What remains is narrower: two DIFFERENT GoHighLevel contacts (their own
 * emails, their own cooldown keys) that findOrCreateCustomer resolves onto
 * the SAME customer row. Even that doesn't collide, because the caller
 * stamps the enrollment date on each request's own matched contact id, not
 * on the shared row, so two near-simultaneous "first" reads produce two
 * independent, correct per-contact stamps rather than one field
 * overwritten. The one value that IS shared, referral_code itself, is
 * protected separately by ensureReferralCode's own conditional claim. A
 * future caller without an equivalent per-identity gate would need to
 * revisit this.
 */
export async function hasReferralCode(customerId: string): Promise<boolean> {
  const sb = svc();
  if (!sb) return false;
  const { data } = await sb
    .from('customers')
    .select('referral_code')
    .eq('id', customerId)
    .maybeSingle<{ referral_code: string | null }>();
  return !!data?.referral_code;
}

/**
 * Create-if-missing the customer's referral code, race-safe: two concurrent
 * callers for the same customer converge on the SAME code (a conditional
 * UPDATE ... WHERE referral_code IS NULL wins at most once; the loser re-reads
 * the winner's value). Returns null when Supabase isn't configured, the
 * customer doesn't exist, or every generation attempt collided (practically
 * never — 32^8 keyspace).
 *
 * Best-effort side effect on first creation only: stamps the referral link
 * onto the customer's GHL contact custom field (fail-open — a GHL outage or
 * missing config never blocks the code itself from existing).
 */
export async function ensureReferralCode(customerId: string): Promise<string | null> {
  const sb = svc();
  if (!sb) return null;

  const { data: existing, error: readErr } = await sb
    .from('customers')
    .select('id, referral_code, hl_contact_id')
    .eq('id', customerId)
    .maybeSingle<{ id: string; referral_code: string | null; hl_contact_id: string | null }>();
  if (readErr) {
    console.error('[referrals] ensureReferralCode read failed:', readErr);
    return null;
  }
  if (!existing) return null;
  if (existing.referral_code) return existing.referral_code;

  for (let attempt = 0; attempt < MAX_CODE_GEN_ATTEMPTS; attempt++) {
    const code = generateReferralCode();
    // Conditional claim: only writes when this customer STILL has no code, so
    // a concurrent ensure call for the same customer can't both "win" with
    // different codes. Filtering .is('referral_code', null) also means a
    // codepath that lost the race just falls through to the re-read below.
    const { data: claimed, error: claimErr } = await sb
      .from('customers')
      .update({ referral_code: code })
      .eq('id', customerId)
      .is('referral_code', null)
      .select('id')
      .maybeSingle();
    if (claimErr) {
      // Unique violation (23505) = another customer already holds this exact
      // code (astronomically rare) — retry with a fresh one.
      if ((claimErr as { code?: string }).code === '23505') continue;
      console.error('[referrals] ensureReferralCode claim failed:', claimErr);
      return null;
    }
    if (claimed) {
      // We won the race — best-effort GHL stamp, first-creation only.
      //
      // Review fix 8: nested after() (Next.js docs: after() can be nested
      // inside other after() calls), not a detached void call. A bare void
      // here would NOT be covered by a caller's own invocation-lifetime
      // extension: per node_modules/next/dist/docs/.../after.md, waitUntil
      // only extends the invocation for the promise(s) actually passed to
      // after(), and a detached child promise started inside an AWAITED
      // after() task is not one of them, since the outer task's own promise
      // can resolve before the detached one finishes. Nesting after() here
      // registers this call with whatever waitUntil the CURRENT request
      // context provides (Route Handlers, Server Components), same as any
      // top-level after() call, with no added latency for any caller (this
      // still doesn't block ensureReferralCode's own return).
      after(() => stampReferralLinkOnContact(existing.hl_contact_id, code));
      return code;
    }
    // Lost the race (a concurrent call already set one) — re-read the winner's code.
    const { data: winner } = await sb
      .from('customers')
      .select('referral_code')
      .eq('id', customerId)
      .maybeSingle<{ referral_code: string | null }>();
    if (winner?.referral_code) return winner.referral_code;
    // Extremely unlikely (the row vanished between claim + re-read) — fall
    // through and try generating again.
  }
  console.error('[referrals] ensureReferralCode: exhausted attempts for customer', customerId);
  return null;
}

// Best-effort: write the referral link to the customer's GHL contact so a
// workflow can merge {{contact.referral_link}}. Fail-open on every axis (no
// contact, GHL not configured, field id not set, or the call itself throwing)
// — the referral code exists regardless of whether this stamp lands.
//
// Exported + returns boolean (naldo/referral-link-sweep, was previously
// private and void-returning): ensureReferralCode above still calls this
// fire-and-forget via after() on first mint only, where the return value is
// irrelevant. The referral sweep needs a SYNCHRONOUS, awaited answer instead:
// it stamps every eligible contact's field itself (not just on first
// mint, since a contact can reach the sweep already holding a code from
// some other path with its OWN field never stamped), and its per-run summary
// counts need to know whether the write actually landed, not just that it
// was scheduled.
export async function stampReferralLinkOnContact(hlContactId: string | null, code: string): Promise<boolean> {
  if (!hlContactId || !isHighLevelConfigured()) return false;
  const fieldId = process.env[REFERRAL_LINK_FIELD_ENV];
  if (!fieldId) {
    console.warn(`[referrals] ${REFERRAL_LINK_FIELD_ENV} not set — skipping referral-link custom field stamp`);
    return false;
  }
  try {
    const link = `${appBaseUrl()}/refer/${code}`;
    await upsertContactCustomField(hlContactId, fieldId, link);
    return true;
  } catch (err) {
    console.error('[referrals] referral-link custom field stamp failed:', err);
    return false;
  }
}

/** Resolve a /refer/<code> landing page to its referrer. Null on a bad/unknown
 *  code or when Supabase isn't configured.
 *
 *  cache()-wrapped because the refer page calls this TWICE per request —
 *  once in generateMetadata for the link-preview card, once in the page
 *  component itself. Next's automatic request memoization covers `fetch()`
 *  calls only, not arbitrary async functions, so without this every page
 *  view costs two Supabase round trips on a public, unrate-limited route.
 *  Same reason and same idiom as getOperator (src/lib/auth/supabaseServer.ts).
 *  cache() is a pass-through no-op outside an RSC render, so the API-route
 *  caller and the unit tests are unaffected. */
export const getReferralByCode = cache(async function getReferralByCode(
  code: string,
): Promise<{ customerId: string; name: string | null; photoOptout: boolean } | null> {
  const sb = svc();
  if (!sb || !code) return null;
  const { data, error } = await sb
    .from('customers')
    .select('id, name, referral_photo_optout')
    .eq('referral_code', code)
    .maybeSingle<{ id: string; name: string | null; referral_photo_optout: boolean | null }>();
  if (error) {
    console.error('[referrals] getReferralByCode failed:', error);
    return null;
  }
  return data
    ? { customerId: data.id, name: data.name, photoOptout: data.referral_photo_optout ?? false }
    : null;
});

// ─── Create ─────────────────────────────────────────────────────────────────

export type CreatePendingReferralInput = {
  source: ReferralSource;
  referrerCustomerId: string;
  /** Known immediately for 'mention'; null for 'link' (no quote exists yet). */
  refereeQuoteId?: string | null;
  refereeContactName?: string | null;
  refereeContactEmail?: string | null;
  refereeContactPhone?: string | null;
  // Self-referral guard (PR 2): when the caller already knows which customer
  // row the referee resolves to (saveQuote's 'mention' flow does, via
  // attachQuoteToCustomer), pass it here so this refuses a customer referring
  // themselves. Omitted/null when unknown (e.g. a 'link' lead-capture row,
  // which has no quote/customer yet) — the guard simply doesn't run then.
  refereeCustomerId?: string | null;
};

/**
 * Create a pending referral row. Both 'link' and 'mention' write the SAME row
 * shape — only `source` and whether `refereeQuoteId` is known differ.
 * Idempotent when refereeQuoteId is provided: a second call for the same
 * quote returns the EXISTING row instead of erroring on the UNIQUE(referee_
 * quote_id) backstop (handles a resave / concurrent retry).
 *
 * Self-referral guard (PR 2): a customer referring themselves would mint a
 * free $125 credit with no new business behind it. Refused (logged + null)
 * whenever the caller supplies refereeCustomerId AND it matches the referrer —
 * saveQuote is the only caller today and ALSO short-circuits before ever
 * reaching here (see quotes.ts), so this is defense in depth for any future
 * caller that passes both ids without doing its own pre-check.
 */
export async function createPendingReferral(
  input: CreatePendingReferralInput,
): Promise<{ id: string } | null> {
  const sb = svc();
  if (!sb) return null;

  if (input.refereeCustomerId && input.refereeCustomerId === input.referrerCustomerId) {
    console.error(
      `[referrals] createPendingReferral refused: self-referral (customer ${input.referrerCustomerId} referring themselves)`,
    );
    return null;
  }

  if (input.refereeQuoteId) {
    const { data: existing } = await sb
      .from('referrals')
      .select('id')
      .eq('referee_quote_id', input.refereeQuoteId)
      .maybeSingle<{ id: string }>();
    if (existing) return { id: existing.id };
  }

  const { data, error } = await sb
    .from('referrals')
    .insert({
      referrer_customer_id: input.referrerCustomerId,
      referee_quote_id: input.refereeQuoteId ?? null,
      referee_contact_name: input.refereeContactName ?? null,
      referee_contact_email: input.refereeContactEmail ?? null,
      referee_contact_phone: input.refereeContactPhone ?? null,
      source: input.source,
      status: 'pending' satisfies ReferralStatus,
    })
    .select('id')
    .single();
  if (error) {
    // Race: another request just inserted the same referee_quote_id between
    // our check and this insert — re-select and return the winner instead of
    // erroring the caller (mirrors customers.ts's insert-race recovery).
    if ((error as { code?: string }).code === '23505' && input.refereeQuoteId) {
      const { data: winner } = await sb
        .from('referrals')
        .select('id')
        .eq('referee_quote_id', input.refereeQuoteId)
        .maybeSingle<{ id: string }>();
      if (winner) return { id: winner.id };
    }
    console.error('[referrals] createPendingReferral failed:', error);
    return null;
  }
  return { id: data.id as string };
}

const DUPLICATE_LINK_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Lightweight duplicate-submit guard for the referral landing page (#41
 * adversarial-review LOW fix): true when this exact (normalized) phone
 * already has a PENDING 'link' referral for the SAME referrer created within
 * the last 24h. Lets the submit route skip minting a second GHL contact +
 * pending referral row when a customer refreshes/resubmits the form (or a
 * double-post). There's no normalized-phone column to query directly, so
 * this fetches the small, already-scoped candidate set (this referrer's
 * recent pending 'link' rows) and normalizes in application code — cheap,
 * no migration needed.
 *
 * Fails OPEN (false = "no duplicate found") on any read error or when
 * Supabase isn't configured — a transient lookup hiccup must never block a
 * genuine new lead from being captured.
 */
export async function hasRecentPendingLinkReferral(
  referrerCustomerId: string,
  normalizedPhone: string,
  windowMs: number = DUPLICATE_LINK_WINDOW_MS,
): Promise<boolean> {
  const sb = svc();
  if (!sb || !referrerCustomerId || !normalizedPhone) return false;
  const since = new Date(Date.now() - windowMs).toISOString();
  const { data, error } = await sb
    .from('referrals')
    .select('referee_contact_phone')
    .eq('referrer_customer_id', referrerCustomerId)
    .eq('source', 'link' satisfies ReferralSource)
    .eq('status', 'pending' satisfies ReferralStatus)
    .gte('created_at', since);
  if (error) {
    console.error('[referrals] hasRecentPendingLinkReferral failed:', error);
    return false;
  }
  return (data ?? []).some(
    (row) => normalizePhone((row as { referee_contact_phone: string | null }).referee_contact_phone) === normalizedPhone,
  );
}

/** A pending 'link' referral matched to an inbound lead, for the quote
 *  builder's "Referred by" prefill. */
export type PendingLinkReferralMatch = {
  referralId: string;
  referrerCustomerId: string;
  referrerName: string | null;
  refereeName: string | null;
  createdAt: string;
  matchedOn: 'phone' | 'email';
};

/**
 * Find the pending 'link' referral belonging to an inbound lead, so the quote
 * builder can SAY "this person came from someone's referral link" instead of
 * relying on a staffer's memory.
 *
 * Why this exists: `accrueOnBooking` only ever matches on `referee_quote_id`,
 * which is set solely when staff pick a referrer in ReferredByPicker while
 * building the friend's quote, before the deposit. Miss that moment and the
 * referrer's credit is unreachable without a developer editing the database.
 * Nothing previously connected the 'link' row the friend created to the quote
 * someone later builds for them.
 *
 * This SUGGESTS, it never auto-attributes. A phone or email match is strong
 * evidence but not proof, and the consequence of being wrong is paying the
 * wrong person, so a human still confirms.
 *
 * Matching notes:
 *  - phone is compared through normalizePhone, so (516) 555-0123 and
 *    +15165550123 are the same lead.
 *  - email is compared lowercased and trimmed.
 *  - 'mention' rows are excluded: those already HAVE a quote attached, and a
 *    mention row means a staffer already did this job.
 *  - only 'pending' status: a booked/credited/expired referral is settled.
 *  - `excludeCustomerId` drops a self-referral, so the builder never invites
 *    a staffer to pay someone for referring themselves.
 *
 * Never throws: this decorates a staff surface and must not be able to break
 * the quote builder.
 */
export async function findPendingLinkReferralForContact(input: {
  phone?: string | null;
  email?: string | null;
  excludeCustomerId?: string | null;
}): Promise<PendingLinkReferralMatch | null> {
  try {
    const sb = svc();
    if (!sb) return null;

    const wantPhone = normalizePhone(input.phone ?? '');
    const wantEmail = (input.email ?? '').trim().toLowerCase();
    if (!wantPhone && !wantEmail) return null;

    const { data, error } = await sb
      .from('referrals')
      .select('id, referrer_customer_id, referee_contact_name, referee_contact_email, referee_contact_phone, created_at')
      .eq('source', 'link' satisfies ReferralSource)
      .eq('status', 'pending' satisfies ReferralStatus);
    if (error) {
      console.error('[referrals] findPendingLinkReferralForContact failed:', error);
      return null;
    }

    type Row = {
      id: string;
      referrer_customer_id: string | null;
      referee_contact_name: string | null;
      referee_contact_email: string | null;
      referee_contact_phone: string | null;
      created_at: string | null;
    };

    const matches: Array<{ row: Row; matchedOn: 'phone' | 'email' }> = [];
    for (const row of (data ?? []) as Row[]) {
      if (!row.referrer_customer_id) continue;
      if (input.excludeCustomerId && row.referrer_customer_id === input.excludeCustomerId) continue;
      if (wantPhone && normalizePhone(row.referee_contact_phone) === wantPhone) {
        matches.push({ row, matchedOn: 'phone' });
        continue;
      }
      if (wantEmail && (row.referee_contact_email ?? '').trim().toLowerCase() === wantEmail) {
        matches.push({ row, matchedOn: 'email' });
      }
    }
    if (matches.length === 0) return null;

    // Newest first: if a lead somehow used two different links, the most
    // recent one is the one they actually followed in.
    matches.sort((a, b) => String(b.row.created_at ?? '').localeCompare(String(a.row.created_at ?? '')));
    const best = matches[0];

    const { data: referrer } = await sb
      .from('customers')
      .select('name')
      .eq('id', best.row.referrer_customer_id as string)
      .maybeSingle<{ name: string | null }>();

    return {
      referralId: best.row.id,
      referrerCustomerId: best.row.referrer_customer_id as string,
      referrerName: referrer?.name ?? null,
      refereeName: best.row.referee_contact_name ?? null,
      createdAt: best.row.created_at ?? '',
      matchedOn: best.matchedOn,
    };
  } catch (err) {
    console.error('[referrals] findPendingLinkReferralForContact threw:', err);
    return null;
  }
}

// ─── Accrual ────────────────────────────────────────────────────────────────

/**
 * Booking event: flip the pending referral for this referee quote to
 * 'booked' + stamp booked_at + expires_at (booked_at + REFERRAL_CREDIT_
 * EXPIRY_YEARS, #41 follow-up), exactly once. Conditional UPDATE (.eq('status',
 * 'pending')) is the same claim idiom as the reply-route claim in
 * src/app/api/dashboard/reply/route.ts — a concurrent/retried booking call
 * can only ever win this claim once. Never throws: every caller is a
 * money-critical payment path that must fail OPEN on an accrual hiccup, so
 * errors are logged and swallowed here rather than left to every call site.
 *
 * On a successful flip, best-effort fires notifyReferrerEarned so the
 * referrer hears about their new credit — see that function for the
 * fail-open contract. A notify failure can NEVER flip `accrued` back to
 * false; it's caught locally, per row, separate from the DB error path.
 */
export async function accrueOnBooking(quoteId: string): Promise<{ accrued: boolean }> {
  try {
    const sb = svc();
    if (!sb) return { accrued: false };
    const bookedAt = new Date();
    const expiresAt = new Date(bookedAt);
    expiresAt.setFullYear(expiresAt.getFullYear() + REFERRAL_CREDIT_EXPIRY_YEARS);
    const { data, error } = await sb
      .from('referrals')
      .update({
        status: 'booked' satisfies ReferralStatus,
        booked_at: bookedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      })
      .eq('referee_quote_id', quoteId)
      .eq('status', 'pending' satisfies ReferralStatus)
      .select('id, referrer_customer_id');
    if (error) {
      console.error('[referrals] accrueOnBooking failed:', error);
      return { accrued: false };
    }
    const flipped = (data ?? []) as Array<{ id: string; referrer_customer_id: string | null }>;
    const accrued = flipped.length > 0;
    for (const row of flipped) {
      try {
        await notifyReferrerEarned({
          referrerCustomerId: row.referrer_customer_id,
          refereeQuoteId: quoteId,
          amountUsd: REFERRAL_CREDIT_USD,
        });
      } catch (err) {
        // Belt-and-suspenders: notifyReferrerEarned already fails open
        // internally, but this booking path must never surface a notify bug
        // as an accrual failure either way.
        console.error('[referrals] notifyReferrerEarned threw (non-fatal):', err);
      }
    }
    return { accrued };
  } catch (err) {
    console.error('[referrals] accrueOnBooking threw:', err);
    return { accrued: false };
  }
}

/**
 * Cancellation reversal (#41 adversarial-review fix): flip a 'booked' (NOT
 * 'credited') referral whose referee_quote_id is the CANCELLED quote back to
 * 'pending', clearing booked_at. A cancelled order never happened, so its
 * referrer shouldn't keep the credit it earned. A 'credited' row is left
 * ALONE on purpose — that credit may already be spent as a discount on a
 * DIFFERENT quote (consumeCredits doesn't know or care which quote earned
 * the credit it's spending), so unwinding it automatically here could rip a
 * discount out from under some other customer's already-approved order;
 * that's a manual/accounting call, not this function's job. Same fail-open
 * contract as accrueOnBooking (its mirror-image sibling): every caller is a
 * cancellation path that must complete regardless of an accrual hiccup, so
 * errors are logged and swallowed here rather than left to the call site.
 */
export async function releaseAccrualOnCancel(quoteId: string): Promise<{ released: boolean }> {
  try {
    const sb = svc();
    if (!sb) return { released: false };
    const { data, error } = await sb
      .from('referrals')
      // expires_at is cleared with booked_at: it derives FROM booked_at, and a
      // re-book later re-stamps both (accrueOnBooking) — a pending row must
      // read as grandfathered-NULL, never carry a stale expiry.
      .update({ status: 'pending' satisfies ReferralStatus, booked_at: null, expires_at: null })
      .eq('referee_quote_id', quoteId)
      .eq('status', 'booked' satisfies ReferralStatus)
      .select('id');
    if (error) {
      console.error('[referrals] releaseAccrualOnCancel failed:', error);
      return { released: false };
    }
    return { released: !!data && data.length > 0 };
  } catch (err) {
    console.error('[referrals] releaseAccrualOnCancel threw:', err);
    return { released: false };
  }
}

/**
 * The exact expiry rule (Naldo locked, #41 follow-up): a row is spendable
 * only when status is 'booked' AND (expires_at is NULL — grandfathered,
 * pre-expiry-column or still-pending rows — OR expires_at is still in the
 * future). Pure + exported so every consumer (creditBalanceFor and
 * consumeCredits' claim filter here, listReferralsFor's display below)
 * applies the SAME rule instead of re-deriving it.
 */
export function isReferralSpendable(
  row: { status: ReferralStatus; expires_at?: string | null },
  now: Date = new Date(),
): boolean {
  if (row.status !== 'booked') return false;
  if (!row.expires_at) return true;
  return new Date(row.expires_at).getTime() > now.getTime();
}

/** A 'booked' row whose expiry has passed — a DISPLAY-only status; the DB
 *  status column is never rewritten to 'expired' (we never rewrite history). */
export function isReferralExpired(
  row: { status: ReferralStatus; expires_at?: string | null },
  now: Date = new Date(),
): boolean {
  return row.status === 'booked' && !isReferralSpendable(row, now);
}

/** The PostgREST filter form of isReferralSpendable's expiry half — pass to
 *  .or() alongside an .eq('status','booked') so DB-side selections and the
 *  pure helper can never drift apart. */
function notExpiredOrFilter(nowIso: string): string {
  return `expires_at.is.null,expires_at.gt.${nowIso}`;
}

/**
 * A referrer's spendable balance: booked-but-not-yet-credited, not-yet-
 * expired referrals × their stored amount. 'credited' rows are EXCLUDED —
 * that status means the credit was already consumed (PR 2's redemption
 * flow), so counting it again here would let a spent credit be "seen" as
 * available twice. A 'booked' row past its expires_at is likewise excluded
 * (see isReferralSpendable) — expired, not spendable, but the DB status stays
 * 'booked' (we never rewrite history).
 */
export async function creditBalanceFor(customerId: string): Promise<number> {
  const sb = svc();
  if (!sb) return 0;
  const { data, error } = await sb
    .from('referrals')
    .select('amount_usd')
    .eq('referrer_customer_id', customerId)
    .eq('status', 'booked' satisfies ReferralStatus)
    .or(notExpiredOrFilter(new Date().toISOString()));
  if (error) {
    console.error('[referrals] creditBalanceFor failed:', error);
    return 0;
  }
  return (data ?? []).reduce((sum, row) => sum + (Number((row as { amount_usd: number }).amount_usd) || 0), 0);
}

// ─── Notify (Feature 2, #41 follow-up) ─────────────────────────────────────

export type NotifyReferrerEarnedInput = {
  referrerCustomerId: string | null;
  /** The BOOKED friend's quote — used to resolve their first name for the copy. */
  refereeQuoteId: string | null;
  amountUsd: number;
};

/**
 * Best-effort "you just earned $125" SMS/email to the referrer, fired from
 * accrueOnBooking's success path so they hear about it once and are nudged
 * to refer again. Fail-open on every axis — no referrer id, no customer row,
 * no linked GHL contact, GHL not configured, the friend's-name lookup
 * failing, or the send itself throwing all resolve to a clean no-op. This
 * function NEVER throws (mirrors accrueOnBooking's own contract) — every
 * internal step is individually guarded so one missing piece (e.g. no phone
 * on file) just skips that channel instead of aborting the whole notify.
 */
export async function notifyReferrerEarned(input: NotifyReferrerEarnedInput): Promise<void> {
  try {
    if (!input.referrerCustomerId) return;
    if (!isHighLevelConfigured()) return;
    const sb = svc();
    if (!sb) return;

    const { data: customer, error: custErr } = await sb
      .from('customers')
      .select('id, name, email, phone, hl_contact_id')
      .eq('id', input.referrerCustomerId)
      .maybeSingle<{
        id: string;
        name: string | null;
        email: string | null;
        phone: string | null;
        hl_contact_id: string | null;
      }>();
    if (custErr) {
      console.error('[referrals] notifyReferrerEarned customer lookup failed:', custErr);
      return;
    }
    if (!customer || !customer.hl_contact_id) return;

    // Resolve the booked friend's first name for the copy (best-effort — a
    // lookup miss falls back to generic wording rather than blocking the send).
    let friendFirstName = 'A friend';
    if (input.refereeQuoteId) {
      const { data: refereeQuote } = await sb
        .from('quotes')
        .select('customer_name')
        .eq('id', input.refereeQuoteId)
        .maybeSingle<{ customer_name: string | null }>();
      const first = refereeQuote?.customer_name?.trim().split(/\s+/)[0];
      if (first) friendFirstName = first;
    }

    const code = await ensureReferralCode(input.referrerCustomerId);
    const referLink = code ? `${appBaseUrl()}/refer/${code}` : appBaseUrl();

    const fromNumber = process.env.HIGHLEVEL_SMS_FROM_NUMBER || undefined;
    const emailFrom = process.env.HIGHLEVEL_EMAIL_FROM || undefined;

    // SMS preferred; email is the fallback channel (no phone on file, or the
    // SMS send itself failed).
    if (customer.phone) {
      try {
        await sendSms({
          contactId: customer.hl_contact_id,
          message: referralEarnedSmsBody(friendFirstName, input.amountUsd, referLink),
          fromNumber,
        });
        return;
      } catch (err) {
        console.error('[referrals] notifyReferrerEarned SMS failed, trying email:', err);
      }
    }
    if (customer.email) {
      try {
        await sendEmail({
          contactId: customer.hl_contact_id,
          subject: REFERRAL_EARNED_EMAIL_SUBJECT,
          html: referralEarnedEmailHtml(friendFirstName, input.amountUsd, referLink),
          emailFrom,
        });
      } catch (err) {
        console.error('[referrals] notifyReferrerEarned email failed:', err);
      }
    }
  } catch (err) {
    console.error('[referrals] notifyReferrerEarned threw (fail-open, no-op):', err);
  }
}

// ─── Redemption (PR 2) ──────────────────────────────────────────────────────

/**
 * The referral row where this quote is the REFEREE (the friend's first
 * quote) — regardless of status (pending/booked/credited). Used by the quote
 * builder's spritzer banner to show "this customer gets 2 free spritzers" on
 * a REOPENED quote, where the client-side "Referred by" picker state (only
 * set in the session that originally picked it) is gone.
 */
export async function refereeReferralFor(
  quoteId: string,
): Promise<{ id: string; status: ReferralStatus } | null> {
  const sb = svc();
  if (!sb || !quoteId) return null;
  const { data, error } = await sb
    .from('referrals')
    .select('id, status')
    .eq('referee_quote_id', quoteId)
    .maybeSingle<{ id: string; status: ReferralStatus }>();
  if (error) {
    console.error('[referrals] refereeReferralFor failed:', error);
    return null;
  }
  return data ?? null;
}

export type ConsumeCreditsResult = {
  consumed: boolean;
  consumedRowIds: string[];
  consumedUsd: number;
  newBalanceUsd: number;
};

/**
 * Spend a referrer's credit balance on a quote — the redemption half of the
 * program (accrueOnBooking above is the earning half).
 *
 * LOCKED, SIMPLIFIED SEMANTICS: a credit is a whole $125 unit, never partial.
 * Applying the balance to a quote consumes ALL of that referrer's currently-
 * 'booked' rows in one shot, flipping every one to 'credited' — regardless of
 * whether the quote's subtotal was big enough to use the full sum. The
 * alternative (bank the unused fraction for a later quote) needs a
 * fractional-credit concept the product never asked for; this keeps the row
 * model simple (a row is either spendable or spent, no in-between). The
 * discount actually BILLED is min(balance, quote subtotal) — computed by the
 * caller (see /api/referrals/consume) — so a cheap quote against a big
 * balance loses the excess above the subtotal. That trade is deliberate and
 * small (it only bites a referrer with several stacked credits applying them
 * to one modest quote); the banner shows the balance BEFORE staff click
 * Apply, so it's a seen trade, not a silent one.
 *
 * `amountUsd` is the amount the caller is about to bill as the quote's
 * discount (always server-computed as min(live balance, quote subtotal) —
 * see the route; never a client-supplied number for a money mutation). It is
 * NOT used to pick which/how many rows to flip (that's always "all of them"
 * per above) — it's a defensive check: if it exceeds the CURRENT live
 * balance, the caller's figure is stale (e.g. a concurrent consume already
 * ran between showing the banner and this click), and this refuses rather
 * than flip rows for a number that no longer reflects reality.
 *
 * Idempotent-ish under a double click: the conditional UPDATE only matches
 * rows still 'booked', so a second call for the same customer (genuine
 * double-click or retry) finds zero rows and returns consumed:false.
 */
export async function consumeCredits(
  customerId: string,
  quoteId: string,
  amountUsd: number,
): Promise<ConsumeCreditsResult> {
  const sb = svc();
  if (!sb) return { consumed: false, consumedRowIds: [], consumedUsd: 0, newBalanceUsd: 0 };

  const liveBalance = await creditBalanceFor(customerId);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > liveBalance) {
    console.error(
      `[referrals] consumeCredits refused: amountUsd ${amountUsd} exceeds live balance ${liveBalance} for customer ${customerId}`,
    );
    return { consumed: false, consumedRowIds: [], consumedUsd: 0, newBalanceUsd: liveBalance };
  }

  // The atomic claim (same idiom as accrueOnBooking above): conditional on
  // status='booked' so a concurrent/retried consume can only ever win once.
  // Ordered oldest-first so the reported consumedRowIds are deterministic —
  // functionally every currently-booked row is consumed regardless of order.
  // The not-expired .or() mirrors creditBalanceFor's filter (#41 expiry):
  // without it, this claim would flip EXPIRED rows to 'credited' — consuming
  // credit the balance above never counted, so consumedUsd would exceed the
  // discount actually billed. Expired rows stay 'booked' forever, unspent.
  const claimNow = new Date().toISOString();
  const { data: updated, error } = await sb
    .from('referrals')
    .update({
      status: 'credited' satisfies ReferralStatus,
      credited_at: claimNow,
      credited_quote_id: quoteId,
    })
    .eq('referrer_customer_id', customerId)
    .eq('status', 'booked' satisfies ReferralStatus)
    .or(notExpiredOrFilter(claimNow))
    // created_at must be IN the returned selection for PostgREST to order a
    // mutation's RETURNING set by it (42703 otherwise — live-E2E-caught S30).
    .select('id, amount_usd, created_at')
    .order('created_at', { ascending: true });

  if (error) {
    console.error('[referrals] consumeCredits update failed:', error);
    return { consumed: false, consumedRowIds: [], consumedUsd: 0, newBalanceUsd: liveBalance };
  }

  const rows = (updated ?? []) as { id: string; amount_usd: number }[];
  if (rows.length === 0) {
    // Lost the race — a concurrent consume already spent the balance between
    // our read above and this claim (e.g. a genuine double click).
    return { consumed: false, consumedRowIds: [], consumedUsd: 0, newBalanceUsd: 0 };
  }

  const consumedUsd = rows.reduce((sum, r) => sum + (Number(r.amount_usd) || 0), 0);
  const newBalanceUsd = await creditBalanceFor(customerId);
  return { consumed: true, consumedRowIds: rows.map((r) => r.id), consumedUsd, newBalanceUsd };
}

export type ReleaseCreditsResult = {
  released: boolean;
  releasedRowIds: string[];
  releasedUsd: number;
};

/**
 * "Remove referral credit" (#41 adversarial-review MED fix) — the undo half
 * of redemption. Flips every row THIS quote credited (credited_quote_id =
 * quoteId, for this referrer) back to 'booked', clearing credited_at/
 * credited_quote_id so the balance is spendable again elsewhere. Same atomic
 * conditional-claim idiom as consumeCredits, reversed: the `.eq('status',
 * 'credited')` filter means a double-call (retry, or a genuine second click
 * after the first already released) finds zero rows the second time —
 * idempotent by construction, no separate guard needed.
 *
 * Scoped to BOTH referrer_customer_id AND credited_quote_id so this can never
 * touch a different quote's spent credit, or a different customer's row —
 * even if a caller passed a mismatched pair (defense in depth; the route
 * layer also validates the quote actually belongs to this customer before
 * calling in).
 */
export async function releaseCredits(customerId: string, quoteId: string): Promise<ReleaseCreditsResult> {
  const sb = svc();
  if (!sb) return { released: false, releasedRowIds: [], releasedUsd: 0 };

  const { data: updated, error } = await sb
    .from('referrals')
    .update({
      status: 'booked' satisfies ReferralStatus,
      credited_at: null,
      credited_quote_id: null,
    })
    .eq('referrer_customer_id', customerId)
    .eq('credited_quote_id', quoteId)
    .eq('status', 'credited' satisfies ReferralStatus)
    .select('id, amount_usd');

  if (error) {
    console.error('[referrals] releaseCredits update failed:', error);
    return { released: false, releasedRowIds: [], releasedUsd: 0 };
  }

  const rows = (updated ?? []) as { id: string; amount_usd: number }[];
  if (rows.length === 0) {
    return { released: false, releasedRowIds: [], releasedUsd: 0 };
  }

  const releasedUsd = rows.reduce((sum, r) => sum + (Number(r.amount_usd) || 0), 0);
  return { released: true, releasedRowIds: rows.map((r) => r.id), releasedUsd };
}

// ─── Customer profile panel (PR 2) ─────────────────────────────────────────

export type ReferralListItem = {
  id: string;
  /** referee_contact_name, else the name on their quote (batched lookup),
   *  else a plain fallback — never blank. */
  displayName: string;
  source: ReferralSource;
  status: ReferralStatus;
  amountUsd: number;
  createdAt: string;
  bookedAt: string | null;
  /** booked_at + 2 years (accrueOnBooking); NULL = grandfathered, never expires. */
  expiresAt: string | null;
  /** Display-only (#41 expiry): a 'booked' row whose expires_at has passed.
   *  The DB status stays 'booked' — see isReferralExpired. */
  expired: boolean;
  creditedAt: string | null;
  creditedQuoteId: string | null;
};

export type ReferralSummary = {
  pendingCount: number;
  /** Booked AND still spendable — expired rows are counted separately so
   *  this stays consistent with spendableUsd (bookedCount × $125). */
  bookedCount: number;
  /** Booked rows whose credit expired unspent (#41 expiry). */
  expiredCount: number;
  creditedCount: number;
  /** Reuses creditBalanceFor's own math (booked-not-yet-credited rows) — see
   *  that function's doc comment for why 'credited' rows are excluded. */
  spendableUsd: number;
  /** Every dollar this referrer has actually earned so far: booked + credited
   *  rows' amounts, regardless of whether the booked half has been spent. */
  lifetimeEarnedUsd: number;
};

/**
 * A referrer's referral history for the customer profile panel: every row
 * they've generated (either source), newest first, with a display name per
 * row and a rollup summary.
 *
 * Display name: the referee's own contact name when known ('link' leads
 * always have one; a 'mention' row's referee is named on their own quote
 * instead), else the name on their referee quote, else a plain fallback.
 * The quote-name fallback is ONE batched `.in('id', ids)` lookup for every
 * row that needs it — never a per-row query.
 */
export async function listReferralsFor(
  customerId: string,
): Promise<{ items: ReferralListItem[]; summary: ReferralSummary }> {
  const empty = {
    items: [] as ReferralListItem[],
    summary: { pendingCount: 0, bookedCount: 0, expiredCount: 0, creditedCount: 0, spendableUsd: 0, lifetimeEarnedUsd: 0 },
  };
  const sb = svc();
  if (!sb || !customerId) return empty;

  const { data, error } = await sb
    .from('referrals')
    .select(
      'id, referee_quote_id, referee_contact_name, source, status, amount_usd, booked_at, expires_at, credited_at, credited_quote_id, created_at',
    )
    .eq('referrer_customer_id', customerId)
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[referrals] listReferralsFor failed:', error);
    return empty;
  }

  type ReferralQueryRow = {
    id: string;
    referee_quote_id: string | null;
    referee_contact_name: string | null;
    source: ReferralSource;
    status: ReferralStatus;
    amount_usd: number;
    booked_at: string | null;
    expires_at: string | null;
    credited_at: string | null;
    credited_quote_id: string | null;
    created_at: string;
  };
  const rows = (data ?? []) as ReferralQueryRow[];
  // One shared instant for every row's expiry check — a list rendered across
  // a now() boundary must not show one row expired and its twin spendable.
  const now = new Date();

  // Batched name fallback: only the quote ids we actually need (rows with no
  // contact name on file), deduped, fetched in ONE call.
  const quoteIdsNeedingName = Array.from(
    new Set(
      rows
        .filter((r) => !r.referee_contact_name?.trim() && r.referee_quote_id)
        .map((r) => r.referee_quote_id as string),
    ),
  );
  const nameByQuoteId = new Map<string, string | null>();
  if (quoteIdsNeedingName.length > 0) {
    const { data: quoteRows, error: quoteErr } = await sb
      .from('quotes')
      .select('id, customer_name')
      .in('id', quoteIdsNeedingName);
    if (quoteErr) {
      console.error('[referrals] listReferralsFor quote name lookup failed:', quoteErr);
    } else {
      for (const q of (quoteRows ?? []) as { id: string; customer_name: string | null }[]) {
        nameByQuoteId.set(q.id, q.customer_name);
      }
    }
  }

  const items: ReferralListItem[] = rows.map((r) => {
    const fallbackName = r.referee_quote_id ? nameByQuoteId.get(r.referee_quote_id) : null;
    return {
      id: r.id,
      displayName: r.referee_contact_name?.trim() || fallbackName?.trim() || 'Unnamed friend',
      source: r.source,
      status: r.status,
      amountUsd: Number(r.amount_usd) || 0,
      createdAt: r.created_at,
      bookedAt: r.booked_at,
      expiresAt: r.expires_at,
      expired: isReferralExpired(r, now),
      creditedAt: r.credited_at,
      creditedQuoteId: r.credited_quote_id,
    };
  });

  const pendingCount = items.filter((i) => i.status === 'pending').length;
  const bookedCount = items.filter((i) => i.status === 'booked' && !i.expired).length;
  const expiredCount = items.filter((i) => i.expired).length;
  const creditedCount = items.filter((i) => i.status === 'credited').length;
  const lifetimeEarnedUsd = items
    .filter((i) => i.status === 'booked' || i.status === 'credited')
    .reduce((sum, i) => sum + i.amountUsd, 0);
  // Reused, not recomputed — creditBalanceFor stays the single source of
  // truth for "spendable" (see its doc comment on excluding 'credited' rows).
  const spendableUsd = await creditBalanceFor(customerId);

  return {
    items,
    summary: { pendingCount, bookedCount, expiredCount, creditedCount, spendableUsd, lifetimeEarnedUsd },
  };
}

// ─── Photo opt-out (PR 1 promised the column; first UI lands in PR 2) ──────

/** Current photo opt-out flag for a customer's /refer/<code> page. False
 *  ("use their photo") when Supabase isn't configured or the row can't be
 *  read — mirrors getReferralByCode's own fail-open default. */
export async function getReferralPhotoOptout(customerId: string): Promise<boolean> {
  const sb = svc();
  if (!sb) return false;
  const { data, error } = await sb
    .from('customers')
    .select('referral_photo_optout')
    .eq('id', customerId)
    .maybeSingle<{ referral_photo_optout: boolean | null }>();
  if (error) {
    console.error('[referrals] getReferralPhotoOptout failed:', error);
    return false;
  }
  return data?.referral_photo_optout ?? false;
}

/** Staff-facing toggle: does this customer's own house photo appear on their
 *  /refer/<code> referral page. Returns false on any failure so the route
 *  can report the save as unsuccessful rather than assume it landed. */
export async function setReferralPhotoOptout(customerId: string, optout: boolean): Promise<boolean> {
  const sb = svc();
  if (!sb) return false;
  const { data, error } = await sb
    .from('customers')
    .update({ referral_photo_optout: optout })
    .eq('id', customerId)
    .select('id');
  if (error) {
    console.error('[referrals] setReferralPhotoOptout failed:', error);
    return false;
  }
  return !!data && data.length > 0;
}
