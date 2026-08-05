// GHL "Years with YLL" custom-field mirror (ledger #200). The quote tool is
// the SOURCE OF TRUTH for a customer's tenure (src/lib/customerTenure.ts);
// this module pushes a FULL-LIST OVERWRITE of that canonical year set onto
// the linked GHL contact's "Years with YLL" TEXT custom field — never the
// reverse. Deliberately NO GHL-side automation writes this field: an
// appending workflow there would fight our overwrites (Jason locked, #200).
//
// Field id: looked up BY NAME at runtime (not a fixed env var like
// quoteLinkFieldId/REFERRAL_LINK_FIELD_ENV) and cached in-process, per #200's
// locked design (no new env var, no manual dashboard step). Created via the
// GHL API the first time it's missing — idempotent find-or-create. If the
// integration token lacks the customFields scope, resolution fails soft (logs
// naming the missing scope) and the push is skipped; staff can create the
// field by hand in the GHL UI (exact name below) as a dashboard fallback —
// the next call's list-by-name lookup then finds it, no code change needed.
//
// Triggers (both call pushTenureYearsToGhl, guarded on customer_id already
// being set — mirrors ensureReferralCode's own call-site guard 1:1, see
// src/lib/referrals.ts):
//   (a) booking — the 3 deposit_paid_at writers (Valor webhook, convert-to-
//       job, simulate-deposit)
//   (b) POST /api/customers/[customerId]/tenure-years (manual-years save)
//
// Fail-soft on every axis (no linked contact, GHL not configured, a scope
// error, any GHL error) — never throws into the caller, mirroring
// accrueOnBooking's contract. No retry queue: the next booking or tenure-edit
// for this customer re-pushes the full set, so a missed push self-heals.

import { getCustomer } from '../customers';
import { getCustomerTenure, MIN_TENURE_YEAR } from '../customerTenure';
import {
  isHighLevelConfigured,
  HighLevelError,
  listLocationCustomFields,
  createLocationCustomField,
  upsertContactCustomField,
} from './highlevel';

export const TENURE_FIELD_NAME = 'Years with YLL';

/**
 * Sorted-ascending, deduped, floor-clamped comma list — e.g. "2023, 2024,
 * 2025". Floor-clamped defensively even though deriveTenureYears already
 * enforces MIN_TENURE_YEAR on MANUAL years (derived years aren't clamped
 * there, by design — see customerTenure.ts) — a formatter that trusts its
 * input blindly is one bad row away from mirroring garbage onto a live GHL
 * contact.
 */
export function formatTenureYearsForGhl(years: number[]): string {
  return Array.from(new Set(years))
    .filter((y) => y >= MIN_TENURE_YEAR)
    .sort((a, b) => a - b)
    .join(', ');
}

let cachedFieldId: string | null = null;

/** Test-only: clear the in-process field-id cache between test cases. */
export function resetTenureFieldCacheForTests(): void {
  cachedFieldId = null;
}

/**
 * Resolve the "Years with YLL" contact custom field id: cached value, else
 * look up by name, else create it. Returns null (never throws) on any
 * failure — including a token that lacks the customFields scope, logged by
 * name so staff know exactly what to fix. Failures are NOT cached, so the
 * next push attempt retries resolution from scratch (self-heals once the
 * scope/field exists — same no-retry-queue philosophy as the push itself).
 */
async function resolveTenureFieldId(): Promise<string | null> {
  if (cachedFieldId) return cachedFieldId;
  try {
    const fields = await listLocationCustomFields();
    const existing = fields.find((f) => f.name === TENURE_FIELD_NAME);
    if (existing) {
      cachedFieldId = existing.id;
      return cachedFieldId;
    }
    const created = await createLocationCustomField({ name: TENURE_FIELD_NAME, dataType: 'TEXT' });
    cachedFieldId = created.id;
    return cachedFieldId;
  } catch (err) {
    if (err instanceof HighLevelError && (err.status === 401 || err.status === 403)) {
      console.error(
        `[ghlTenure] GHL token appears to lack the customFields scope (HTTP ${err.status}) while resolving "${TENURE_FIELD_NAME}" — add the Custom Fields scope to the Private Integration token, or create the field by hand in the GHL UI (Contacts > Custom Fields, TEXT type, named exactly "${TENURE_FIELD_NAME}") as a fallback. Skipping tenure push.`,
      );
      return null;
    }
    console.error(`[ghlTenure] failed to resolve/create the "${TENURE_FIELD_NAME}" custom field:`, err);
    return null;
  }
}

/**
 * Push this customer's full tenure year set to their linked GHL contact's
 * "Years with YLL" field — a FULL-LIST OVERWRITE (never an append). No-op
 * (returns { pushed: false }) when there's no customerId, no linked GHL
 * contact, HighLevel isn't configured, or the field can't be resolved.
 *
 * is_test guard: this takes a customerId, not a quoteId, and a test quote's
 * customer_id is ALWAYS null (saveQuote skips attachQuoteToCustomer when
 * is_test — see src/lib/quotes.ts) — so "no customerId" already excludes
 * every is_test path structurally, the exact same guard ensureReferralCode's
 * own call sites already rely on (`if (quote.customer_id) await
 * ensureReferralCode(...)`). No separate is_test parameter needed here.
 *
 * Never throws — every failure is caught, logged, and swallowed, matching
 * accrueOnBooking's fail-open contract; every caller is a booking or a
 * staff-save path that must complete regardless of a GHL hiccup.
 */
export async function pushTenureYearsToGhl(
  customerId: string | null | undefined,
): Promise<{ pushed: boolean }> {
  try {
    if (!customerId) return { pushed: false };
    if (!isHighLevelConfigured()) return { pushed: false };

    const customer = await getCustomer(customerId);
    if (!customer || !customer.hl_contact_id) return { pushed: false };

    const tenure = await getCustomerTenure(customerId, customer.hl_contact_id, new Date());
    const value = formatTenureYearsForGhl(tenure.years);

    const fieldId = await resolveTenureFieldId();
    if (!fieldId) return { pushed: false };

    await upsertContactCustomField(customer.hl_contact_id, fieldId, value);
    return { pushed: true };
  } catch (err) {
    console.error('[ghlTenure] pushTenureYearsToGhl failed (non-fatal):', err);
    return { pushed: false };
  }
}
