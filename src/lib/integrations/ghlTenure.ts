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
// Fail-soft on every axis (no linked contact, GHL not configured, an empty
// computed year set, a scope error, any GHL error) — never throws into the
// caller, mirroring accrueOnBooking's contract. No retry queue: the next
// booking or tenure-edit for this customer re-pushes the full set, so a
// missed push self-heals. Deadline-bounded (PUSH_DEADLINE_MS, ~6s) since the
// booking + tenure-edit-save call sites AWAIT this — see
// pushTenureYearsToGhl's own doc comment.

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
    .filter((y) => Number.isInteger(y) && y >= MIN_TENURE_YEAR)
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

    // Empty-list parse guard (review fix batch, #200 tech-lens HIGH): this
    // location provably has OTHER contact custom fields already (the
    // quote-link fields per service_type, the referral-link field — see
    // ghlPipelineMap.ts / referrals.ts), so a list response with ZERO fields
    // is a red flag for a response-wrapper parse bug, not genuine emptiness —
    // the same failure class as highlevel.ts's getConversationMessages
    // `messages.messages` double-nesting note (a wrong/nested wrapper key
    // silently returning "empty" instead of throwing). Refusing to create
    // here turns that failure mode into a safe no-op instead of an unbounded
    // duplicate-field-creation loop (one new field per booking).
    if (fields.length === 0) {
      console.error(
        '[ghlTenure] custom-field list came back EMPTY for a location known to have custom fields (quote-link/referral fields exist) — likely a response-wrapper parse bug; refusing to auto-create to avoid duplicate fields',
      );
      return null;
    }

    // Trim + case-fold the match (review fix batch, tech-lens MED) — the
    // docstring's "create it by hand in the GHL UI" fallback must survive a
    // human typing a trailing space or different casing.
    const folded = TENURE_FIELD_NAME.toLowerCase();
    const matches = fields.filter((f) => f.name.trim().toLowerCase() === folded);

    if (matches.length > 1) {
      // Dup detection (review fix batch, admin-lens MED): pick deterministically
      // (lowest id) so every process instance converges on the SAME field
      // instead of each warm instance silently drifting to a different one.
      const ids = matches.map((f) => f.id).sort();
      console.warn(
        `[ghlTenure] ${matches.length} custom fields match "${TENURE_FIELD_NAME}" (ids: ${ids.join(', ')}) — using the lowest id deterministically; consider deleting the duplicates in the GHL UI.`,
      );
      cachedFieldId = ids[0]!;
      return cachedFieldId;
    }
    if (matches.length === 1) {
      cachedFieldId = matches[0]!.id;
      return cachedFieldId;
    }

    // No match in a NON-empty list — genuinely missing, safe to create.
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

// Review fix batch (#200 staff-lens MED): the interactive tenure-editor save
// and convert-to-job both AWAIT this call, and ghlFetch has no AbortController
// (no fetch-level cancellation) — a slow/hung GHL call could otherwise block
// a staff click for as long as the platform's own request timeout. Bounds the
// WHOLE push (DB reads included, not just the GHL leg) to a flat deadline.
const PUSH_DEADLINE_MS = 6000;

/**
 * The actual push logic — see pushTenureYearsToGhl (the exported, deadline-
 * bounded wrapper below) for the full contract.
 */
async function pushTenureYearsToGhlInner(
  customerId: string | null | undefined,
): Promise<{ pushed: boolean }> {
  try {
    if (!customerId) return { pushed: false };
    if (!isHighLevelConfigured()) return { pushed: false };

    const customer = await getCustomer(customerId);
    if (!customer || !customer.hl_contact_id) return { pushed: false };

    const tenure = await getCustomerTenure(customerId, customer.hl_contact_id, new Date());
    const value = formatTenureYearsForGhl(tenure.years);

    // Skip-on-empty (review fix batch, #200 admin-lens HIGH): getTenureQuotes
    // fails OPEN on a transient DB read error (returns [] — see
    // customerTenure.ts), so "computed nothing" can mean "genuinely zero
    // history" OR "the read hiccuped." Either way, an OVERWRITE side effect
    // must treat "nothing computed" as "nothing to report," never as "report
    // zero" — clobbering a previously-correct GHL value on a transient blip
    // would be worse than leaving it stale. Checked BEFORE resolving the
    // field id, which also skips that round trip. Cost accepted: a customer
    // whose tenure is genuinely emptied (all quotes removed/re-flagged) keeps
    // a stale GHL value until some other trigger overwrites it.
    if (value === '') {
      console.error('[ghlTenure] computed empty year set — skipping push (field left as-is)');
      return { pushed: false };
    }

    const fieldId = await resolveTenureFieldId();
    if (!fieldId) return { pushed: false };

    try {
      await upsertContactCustomField(customer.hl_contact_id, fieldId, value);
      return { pushed: true };
    } catch (err) {
      // Clear-cache-on-failure (review fix batch, tech-lens MED): a human
      // deleting/renaming the field in GHL must not silently no-op every
      // push from this warm instance until a cold start — force the NEXT
      // push to re-resolve (list-by-name, or re-create if truly gone) rather
      // than reusing a now-dead id forever. Re-throw so the outer catch below
      // still owns the standard fail-soft logging (one message, not two).
      cachedFieldId = null;
      throw err;
    }
  } catch (err) {
    console.error('[ghlTenure] pushTenureYearsToGhl failed (non-fatal):', err);
    return { pushed: false };
  }
}

/**
 * Push this customer's full tenure year set to their linked GHL contact's
 * "Years with YLL" field — a FULL-LIST OVERWRITE (never an append). No-op
 * (returns { pushed: false }) when there's no customerId, no linked GHL
 * contact, HighLevel isn't configured, the computed year set is empty, or the
 * field can't be resolved.
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
 *
 * DEADLINE (review fix batch): bounded to PUSH_DEADLINE_MS via Promise.race.
 * On expiry this resolves { pushed: false } and logs a timeout — the
 * underlying DB/GHL calls are NOT cancelled (ghlFetch has no
 * AbortController; out of scope to add one here) and may still complete in
 * the background after this function has already returned. Acceptable: the
 * worst case is a late, otherwise-harmless GHL write racing a later push,
 * which the full-overwrite design already tolerates.
 */
export async function pushTenureYearsToGhl(
  customerId: string | null | undefined,
): Promise<{ pushed: boolean }> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<{ pushed: boolean }>((resolve) => {
    timer = setTimeout(() => {
      console.error(
        `[ghlTenure] push timed out after ${PUSH_DEADLINE_MS}ms — resolving pushed:false (the underlying call(s) may still complete in the background)`,
      );
      resolve({ pushed: false });
    }, PUSH_DEADLINE_MS);
  });
  try {
    return await Promise.race([pushTenureYearsToGhlInner(customerId), deadline]);
  } finally {
    clearTimeout(timer!);
  }
}
