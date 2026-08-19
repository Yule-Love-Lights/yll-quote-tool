// GHL "Event Date" custom-field push (ledger #237). When an EVENT-service-type
// quote is sent, mirror the staff-entered event date onto the linked GHL
// contact's "Event Date" custom field so a GHL automation (a reminder
// workflow, a merge field in a follow-up SMS/email) can read it without staff
// re-typing it into the CRM by hand.
//
// Field id: resolved BY NAME at runtime and cached in-process — the exact
// find-or-create-by-name pattern ghlTenure.ts (#200) established: an EMPTY
// custom-field list is treated as a parse-bug red flag (refuses to
// auto-create rather than risk an unbounded duplicate-field-creation loop),
// the name match is trimmed + case-folded, duplicate matches resolve
// deterministically to the lowest id, and a 401/403 scope error fails soft
// (logs the missing scope, does not poison the cache) so staff can create the
// field by hand in the GHL UI as a fallback. See ghlTenure.ts's
// resolveTenureFieldId for the full reasoning; this file reuses that shape
// 1:1 rather than re-deriving it (per ledger #237's brief), duplicated
// (not shared) only because the two fields' names/dataTypes differ and each
// function is short enough that a shared abstraction would cost more
// indirection than it saves.
//
// VALUE FORMAT (ledger #237 open item (a), resolved here): pushed as
// MM/DD/YYYY, built by splitting the source `YYYY-MM-DD` string directly —
// never by constructing a `Date` and re-formatting it. The source
// (`inputs.event.eventDate`, a plain `<input type="date">` string, see
// EventInputFields in src/lib/event/types.ts) carries no time or timezone
// component; running it through `new Date(...)` would attach one (UTC
// midnight) and re-formatting with any locale/timezone-aware method risks
// displaying the wrong calendar day depending on the server runtime's
// timezone — exactly the silent-shift class of bug formatTenureYearsForGhl's
// own comment warns "a formatter that trusts its input blindly" invites. Pure
// string manipulation makes that bug structurally impossible: no Date object
// is ever created, so there is no timezone in the path to shift anything.
// MM/DD/YYYY (not the raw ISO string) because this field's whole purpose is
// to be READ — by a staffer in the GHL UI, or merged into a customer-facing
// automation — and MM/DD/YYYY is what this US business already writes dates
// as elsewhere (see quoteMessages / portal date formatting). TEXT dataType
// (not a native GHL DATE field), for the same reason ghlTenure.ts defaults to
// TEXT: upsertContactCustomField passes its value straight through untouched,
// and TEXT is the only live precedent for what format this call site actually
// produces correctly — a native DATE field likely expects its own specific
// format, and since this whole push is fail-soft and never throws, guessing
// wrong there would store garbage silently. Only deviate after verifying
// against a real GHL DATE field (the ledger row's own instruction).

import {
  isHighLevelConfigured,
  HighLevelError,
  listLocationCustomFields,
  createLocationCustomField,
  upsertContactCustomField,
} from './highlevel';

export const EVENT_DATE_FIELD_NAME = 'Event Date';

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD` -> `MM/DD/YYYY` by pure string splitting — see the file header
 * for why no `Date` object is ever constructed here. Returns '' for anything
 * that is not exactly that shape (missing/blank/malformed input); callers
 * treat '' as "nothing to push." The month/day range check (01-12 / 01-31) is
 * defense-in-depth against a corrupt upstream value — a native
 * `<input type="date">` never produces an out-of-range value, mirroring
 * formatTenureYearsForGhl's own "do not trust the input blindly" stance even
 * though its own callers are already validated.
 *
 * FIX C (#237 fix round, technical-lens MED): "range" means real CALENDAR
 * validity, not just 01-12 / 01-31 — the old bounds let 2026-02-30 (February
 * has 28/29 days, never 30) and 2026-04-31 (April has 30) through unchanged,
 * so they'd have been pushed verbatim to a real customer's GHL contact.
 * isValidCalendarDate below checks the real day-count for the given month +
 * year (leap-year-aware) WITHOUT ever constructing a `Date` — the file
 * header's whole reason for pure string/number splitting (no UTC-vs-local
 * shift possible) would be defeated by reaching for `new Date(...).getDate()
 * !== dayNum` here just to validate.
 */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12) return false;
  const max = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1]!;
  return day >= 1 && day <= max;
}

export function formatEventDateForGhl(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  const m = ISO_DATE_RE.exec(raw.trim());
  if (!m) return '';
  const [, year, month, day] = m;
  const yearNum = Number(year);
  const monthNum = Number(month);
  const dayNum = Number(day);
  if (!isValidCalendarDate(yearNum, monthNum, dayNum)) return '';
  return `${month}/${day}/${year}`;
}

let cachedFieldId: string | null = null;

/** Test-only: clear the in-process field-id cache between test cases. */
export function resetEventDateFieldCacheForTests(): void {
  cachedFieldId = null;
}

/**
 * Resolve the "Event Date" contact custom field id: cached value, else look
 * up by name, else create it. Returns null (never throws) on any failure —
 * including a token that lacks the customFields scope, logged by name so
 * staff know exactly what to fix. Failures are NOT cached, so the next push
 * attempt retries resolution from scratch. 1:1 with ghlTenure.ts's
 * resolveTenureFieldId — see that file for the reasoning behind each guard.
 */
async function resolveEventDateFieldId(): Promise<string | null> {
  if (cachedFieldId) return cachedFieldId;
  try {
    const fields = await listLocationCustomFields();

    // Empty-list parse guard (mirrors ghlTenure.ts's resolveTenureFieldId):
    // this location provably has other contact custom fields already
    // (quote-link fields per service_type, the referral-link field, the
    // tenure field — see ghlPipelineMap.ts / referrals.ts / ghlTenure.ts), so
    // a list response with ZERO fields is a red flag for a response-wrapper
    // parse bug, not genuine emptiness. Refusing to create here turns that
    // failure mode into a safe no-op instead of an unbounded
    // duplicate-field-creation loop (one new field per event send).
    if (fields.length === 0) {
      console.error(
        '[ghlEventDate] custom-field list came back EMPTY for a location known to have custom fields (quote-link/referral/tenure fields exist) — likely a response-wrapper parse bug; refusing to auto-create to avoid duplicate fields',
      );
      return null;
    }

    // Trim + case-fold the match — the docstring's "create it by hand in the
    // GHL UI" fallback must survive a human typing a trailing space or
    // different casing.
    const folded = EVENT_DATE_FIELD_NAME.toLowerCase();
    const matches = fields.filter((f) => f.name.trim().toLowerCase() === folded);

    if (matches.length > 1) {
      // Dup detection: pick deterministically (lowest id) so every process
      // instance converges on the SAME field instead of each warm instance
      // silently drifting to a different one.
      const ids = matches.map((f) => f.id).sort();
      console.warn(
        `[ghlEventDate] ${matches.length} custom fields match "${EVENT_DATE_FIELD_NAME}" (ids: ${ids.join(', ')}) — using the lowest id deterministically; consider deleting the duplicates in the GHL UI.`,
      );
      cachedFieldId = ids[0]!;
      return cachedFieldId;
    }
    if (matches.length === 1) {
      cachedFieldId = matches[0]!.id;
      return cachedFieldId;
    }

    // No match in a NON-empty list — genuinely missing, safe to create.
    const created = await createLocationCustomField({ name: EVENT_DATE_FIELD_NAME, dataType: 'TEXT' });
    cachedFieldId = created.id;
    return cachedFieldId;
  } catch (err) {
    if (err instanceof HighLevelError && (err.status === 401 || err.status === 403)) {
      console.error(
        `[ghlEventDate] GHL token appears to lack the customFields scope (HTTP ${err.status}) while resolving "${EVENT_DATE_FIELD_NAME}" — add the Custom Fields scope to the Private Integration token, or create the field by hand in the GHL UI (Contacts > Custom Fields, TEXT type, named exactly "${EVENT_DATE_FIELD_NAME}") as a fallback. Skipping event-date push.`,
      );
      return null;
    }
    console.error(`[ghlEventDate] failed to resolve/create the "${EVENT_DATE_FIELD_NAME}" custom field:`, err);
    return null;
  }
}

// Deadline-bounded (mirrors ghlTenure.ts's PUSH_DEADLINE_MS Promise.race
// exactly, including clearing the timer in `finally` regardless of which
// side wins) since the send route awaits this from inside its own
// best-effort GHL stage chain — a slow/hung GHL call here must never delay
// the customer's send response.
const PUSH_DEADLINE_MS = 6000;

/**
 * The actual push logic — see pushEventDateToGhl (the exported,
 * deadline-bounded wrapper below) for the full contract.
 */
async function pushEventDateToGhlInner(
  contactId: string | null | undefined,
  eventDate: string | null | undefined,
): Promise<{ pushed: boolean }> {
  try {
    if (!contactId) return { pushed: false };
    if (!isHighLevelConfigured()) return { pushed: false };

    const value = formatEventDateForGhl(eventDate);
    // Missing/blank/malformed date: do nothing, quietly (ledger #237
    // requirement) — not an error, just nothing to report.
    if (!value) return { pushed: false };

    const fieldId = await resolveEventDateFieldId();
    if (!fieldId) return { pushed: false };

    try {
      await upsertContactCustomField(contactId, fieldId, value);
      return { pushed: true };
    } catch (err) {
      // Clear-cache-on-failure (mirrors ghlTenure.ts): a human
      // deleting/renaming the field in GHL must not silently no-op every
      // push from this warm instance until a cold start — force the NEXT
      // push to re-resolve rather than reusing a now-dead id forever.
      // Re-throw so the outer catch below still owns the standard fail-soft
      // logging (one message, not two).
      cachedFieldId = null;
      throw err;
    }
  } catch (err) {
    console.error('[ghlEventDate] pushEventDateToGhl failed (non-fatal):', err);
    return { pushed: false };
  }
}

/**
 * Push an event quote's staff-entered event date to its linked GHL contact's
 * "Event Date" custom field — a plain overwrite (there is only ever one
 * event date per quote, unlike ghlTenure's full-list mirror). No-op (returns
 * { pushed: false }) when there's no contactId, HighLevel isn't configured,
 * the date is missing/blank/malformed, or the field can't be resolved.
 *
 * Never throws — every failure is caught, logged, and swallowed, matching
 * pushTenureYearsToGhl's fail-open contract; the caller (the send route's GHL
 * stage chain) must complete regardless of a GHL hiccup so it never delays or
 * fails a customer send.
 *
 * DEADLINE: bounded to PUSH_DEADLINE_MS via Promise.race, 1:1 with
 * pushTenureYearsToGhl. On expiry this resolves { pushed: false } and logs a
 * timeout — the race itself does not cancel the losing call, so the
 * background continuation may still complete after this function has already
 * returned (the same honestly-documented tradeoff ghlTenure.ts's own
 * PUSH_DEADLINE_MS carries, for the same reason: a late, otherwise-harmless
 * GHL write racing a later push is fine for a field that's always a plain
 * overwrite of the latest known value).
 */
export async function pushEventDateToGhl(
  contactId: string | null | undefined,
  eventDate: string | null | undefined,
): Promise<{ pushed: boolean }> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<{ pushed: boolean }>((resolve) => {
    timer = setTimeout(() => {
      console.error(
        `[ghlEventDate] push timed out after ${PUSH_DEADLINE_MS}ms — resolving pushed:false (the underlying call(s) may still complete in the background)`,
      );
      resolve({ pushed: false });
    }, PUSH_DEADLINE_MS);
  });
  try {
    return await Promise.race([pushEventDateToGhlInner(contactId, eventDate), deadline]);
  } finally {
    clearTimeout(timer!);
  }
}
