// Referral program, PR 1 (ledger #41). Locked product (Naldo, S30): the
// referrer earns $125 next-season credit per booked friend, stackable — one
// credit per friend who books, no cap. The friend gets two free 16" spritzers
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

import { getSupabaseServiceClient } from './supabase';
import { randomBytes } from 'crypto';
import { upsertContactCustomField, isHighLevelConfigured } from './integrations/highlevel';
import { appBaseUrl } from './integrations/telegramNotify';

// ─── Constants ──────────────────────────────────────────────────────────────

/** Next-season credit a referrer earns per booked friend (USD). */
export const REFERRAL_CREDIT_USD = 125;

/** What the referred friend gets on their first booked install. */
export const REFERRAL_FRIEND_SPRITZERS = { count: 2, sizeInches: 16 } as const;

/** The env var backing the GHL contact custom field that carries the
 *  referrer's personal link (so a workflow can merge {{contact.referral_link}}).
 *  Unset ⇒ the stamp is skipped (mirrors quoteLinkFieldId's fail-open contract). */
const REFERRAL_LINK_FIELD_ENV = 'HIGHLEVEL_CONTACT_FIELD_REFERRAL_LINK';

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
      void stampReferralLinkOnContact(existing.hl_contact_id, code);
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
async function stampReferralLinkOnContact(hlContactId: string | null, code: string): Promise<void> {
  if (!hlContactId || !isHighLevelConfigured()) return;
  const fieldId = process.env[REFERRAL_LINK_FIELD_ENV];
  if (!fieldId) {
    console.warn(`[referrals] ${REFERRAL_LINK_FIELD_ENV} not set — skipping referral-link custom field stamp`);
    return;
  }
  try {
    const link = `${appBaseUrl()}/refer/${code}`;
    await upsertContactCustomField(hlContactId, fieldId, link);
  } catch (err) {
    console.error('[referrals] referral-link custom field stamp failed:', err);
  }
}

/** Resolve a /refer/<code> landing page to its referrer. Null on a bad/unknown
 *  code or when Supabase isn't configured. */
export async function getReferralByCode(
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
}

// ─── Create ─────────────────────────────────────────────────────────────────

export type CreatePendingReferralInput = {
  source: ReferralSource;
  referrerCustomerId: string;
  /** Known immediately for 'mention'; null for 'link' (no quote exists yet). */
  refereeQuoteId?: string | null;
  refereeContactName?: string | null;
  refereeContactEmail?: string | null;
  refereeContactPhone?: string | null;
};

/**
 * Create a pending referral row. Both 'link' and 'mention' write the SAME row
 * shape — only `source` and whether `refereeQuoteId` is known differ.
 * Idempotent when refereeQuoteId is provided: a second call for the same
 * quote returns the EXISTING row instead of erroring on the UNIQUE(referee_
 * quote_id) backstop (handles a resave / concurrent retry).
 */
export async function createPendingReferral(
  input: CreatePendingReferralInput,
): Promise<{ id: string } | null> {
  const sb = svc();
  if (!sb) return null;

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

// ─── Accrual ────────────────────────────────────────────────────────────────

/**
 * Booking event: flip the pending referral for this referee quote to
 * 'booked' + stamp booked_at, exactly once. Conditional UPDATE (.eq('status',
 * 'pending')) is the same claim idiom as the reply-route claim in
 * src/app/api/dashboard/reply/route.ts — a concurrent/retried booking call
 * can only ever win this claim once. Never throws: every caller is a
 * money-critical payment path that must fail OPEN on an accrual hiccup, so
 * errors are logged and swallowed here rather than left to every call site.
 */
export async function accrueOnBooking(quoteId: string): Promise<{ accrued: boolean }> {
  try {
    const sb = svc();
    if (!sb) return { accrued: false };
    const { data, error } = await sb
      .from('referrals')
      .update({ status: 'booked' satisfies ReferralStatus, booked_at: new Date().toISOString() })
      .eq('referee_quote_id', quoteId)
      .eq('status', 'pending' satisfies ReferralStatus)
      .select('id');
    if (error) {
      console.error('[referrals] accrueOnBooking failed:', error);
      return { accrued: false };
    }
    return { accrued: !!data && data.length > 0 };
  } catch (err) {
    console.error('[referrals] accrueOnBooking threw:', err);
    return { accrued: false };
  }
}

/**
 * A referrer's spendable balance: booked-but-not-yet-credited referrals ×
 * their stored amount. 'credited' rows are EXCLUDED — that status means the
 * credit was already consumed (PR 2's redemption flow), so counting it again
 * here would let a spent credit be "seen" as available twice.
 */
export async function creditBalanceFor(customerId: string): Promise<number> {
  const sb = svc();
  if (!sb) return 0;
  const { data, error } = await sb
    .from('referrals')
    .select('amount_usd')
    .eq('referrer_customer_id', customerId)
    .eq('status', 'booked' satisfies ReferralStatus);
  if (error) {
    console.error('[referrals] creditBalanceFor failed:', error);
    return 0;
  }
  return (data ?? []).reduce((sum, row) => sum + (Number((row as { amount_usd: number }).amount_usd) || 0), 0);
}
