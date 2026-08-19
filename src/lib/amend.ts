// Amend a booked order — the PURE re-price-with-deposit + amendment-trail core
// (ledger #83 Phase 4, the "delicate" phase). SPEC §4.4 / PLAN Phase 4.
//
// What this module IS: pure functions that, given a booked order's current
// figures (previous total / deposit already paid / previous balance) and a NEW
// total, compute the new balance, the amendment-trail entry to append to
// `approval_snapshot.amendments[]`, the re-consent predicate, and the resulting
// quote status. No IO, no Supabase, no Valor, no HighLevel — every input is a
// plain object so the math is trivially testable and reusable from the live
// amend route (src/app/api/quotes/[id]/amend/route.ts).
//
// What this module is NOT (that integration lives in the route, not here — see
// the note at the bottom): it does NOT re-open the order, write the trail,
// charge/refund a card, move a GHL stage, or touch the approve route / portal
// lock / Valor webhook. Amending re-opens a BOOKED order, which rewrites the
// "freeze snapshot / read-only after approval" assumption the revenue-critical
// booking path relies on (approve route 409, portal lock). That integration +
// the operator/customer amend SURFACE move money, so they live behind the #81
// auth perimeter, in the route, NOT here.
//
// Reuse, don't reinvent: the new total is produced by the SAME pricing the
// portal + approve route use (ultimately `pricingEngine`). Callers hold an
// already-priced total and pass its `.total` straight into `computeAmendment`.

import type { QuoteStatus } from './quoteStatus';
// #110 W1-064: shared EPSILON-nudged + finite-guarded round-to-cents (was copy-
// pasted here / invoices.ts / balanceCollection.ts). Aliased to `round2` so the
// call sites are byte-identical, and so the amend and the invoice it feeds still
// round a balance identically (a half-cent boundary can't diverge).
import { roundMoneyGuarded as round2 } from './money';

// Sub-cent deltas are treated as no change: float arithmetic on re-priced
// selections can leave a fraction-of-a-cent difference that is NOT a real price
// change and must not trigger re-consent or a balance move.
const ONE_CENT = 0.005;

/**
 * A single line-item change in an amendment, for the human-readable trail. The
 * pure core records these verbatim (it does not derive them — the caller diffs
 * the old vs new selection and supplies the list). Optional: a price-only
 * amendment (e.g. a discount) may carry an empty list.
 */
export type AmendmentLineItemChange = {
  id: string;
  label: string;
  change: 'added' | 'removed' | 'changed';
  // The line-item price (dollars) for context in the trail. Optional because a
  // 'changed' entry may instead carry from/to below.
  price?: number;
  priceFrom?: number;
  priceTo?: number;
};

/**
 * One entry appended to `approval_snapshot.amendments[]`. The ORIGINAL signed
 * snapshot is never overwritten — the signature attests to the original
 * agreement; this is the versioned trail of what changed after (SPEC §4.4). A
 * plain serializable object (safe to JSON-store as jsonb).
 */
export type AmendmentConsentSignature = {
  name: string;
  kind: 'typed' | 'drawn';
  value: string;
  signed_at: string;
  ip: string | null;
};

// 'declined' (ledger #83 follow-up, a real live incident — a customer had no
// way to say no and had to phone in): the customer explicitly refused this
// price change. Deliberately NOT a reversion — only staff can un-price a
// booked order (they re-price it in the builder and record a NEW amendment);
// this just RECORDS the refusal so it is unmistakable to staff and so
// settlement stays blocked. `reason` is the customer's own optional free text
// (distinct from `AmendmentTrailEntry.reason`, which is STAFF's text describing
// the change) — never echoed back into a customer-facing notice, staff-only.
// `ip` mirrors the signature's own audit field, captured the same way, for the
// same reason (a cheap provenance breadcrumb on a public capability-token
// endpoint) even though there is no signature to attach it to.
export type AmendmentConsent =
  | { status: 'pending' }
  | { status: 'accepted'; accepted_at: string; signature: AmendmentConsentSignature }
  | { status: 'declined'; declined_at: string; reason?: string; ip: string | null };

export type AmendmentTrailEntry = {
  amended_at: string; // ISO 8601
  by: string; // operator identity (e.g. 'staff:naldo') — supplied by the caller
  reason: string; // why the order was amended
  previous_total: number;
  new_total: number;
  previous_balance: number;
  new_balance: number;
  // The deposit already paid — IMMUTABLE input, echoed unchanged. Recorded so the
  // trail is self-describing (you can re-derive new_balance from it).
  deposit_applied: number;
  // new_total − previous_total. Positive = customer owes more, negative = less.
  delta: number;
  line_item_changes: AmendmentLineItemChange[];
  // Set ONLY when the deposit already exceeds the new total (price dropped below
  // what was paid). The customer is owed `credit_note` dollars; refunds are
  // MANUAL in Valor (no refund integration — SPEC §2 cancellations decision).
  // Absent on a normal amendment.
  credit_note?: number;
  overpayment?: boolean;
  // Total-changing amendments start pending. The public portal replaces this
  // with an accepted, server-stamped signature — or a declined refusal —
  // without changing booked status. Missing on historical entries means
  // pending for backward compatibility.
  consent?: AmendmentConsent;
};

export type ComputeAmendmentInput = {
  // The order's CURRENT figures (before this amendment). On a second amendment,
  // these are the prior amendment's new_total / deposit_applied / new_balance.
  previousTotal: number;
  depositPaid: number; // immutable — never re-charged, never mutated
  previousBalance: number;
  // The re-priced NEW total (tax-inclusive), from the pricing engine.
  newTotal: number;
  by: string;
  reason: string;
  lineItemChanges?: AmendmentLineItemChange[];
  // Override the clock (tests). Defaults to now.
  now?: () => Date;
};

/**
 * Compute the amendment-trail entry for re-pricing a booked order with the
 * deposit already applied. PURE — no IO.
 *
 *   new_balance = max(0, new_total − deposit_paid)
 *
 * Money-safety guards:
 *  - new total must be a finite, non-negative number (NaN / Infinity / negative
 *    are programmer/route-validation errors and throw — the future route
 *    validates the body first; this is the last-line guard).
 *  - deposit paid must be a finite, non-negative number.
 *  - the new balance is CLAMPED at ≥ 0: if the deposit ≥ the new total, the
 *    balance is 0 and a `credit_note` (the overpayment) is surfaced for a MANUAL
 *    Valor refund (no refund integration — SPEC §2).
 *  - the deposit is IMMUTABLE: it is echoed unchanged into the trail; only the
 *    balance moves. The deposit is never re-charged.
 *  - all money is rounded to cents.
 */
export function computeAmendment(input: ComputeAmendmentInput): AmendmentTrailEntry {
  const { previousTotal, depositPaid, previousBalance, newTotal, by, reason } = input;

  if (!Number.isFinite(newTotal)) {
    throw new Error(`computeAmendment: new total must be a finite number (got ${newTotal})`);
  }
  if (newTotal < 0) {
    throw new Error(`computeAmendment: new total cannot be negative (got ${newTotal})`);
  }
  if (!Number.isFinite(depositPaid) || depositPaid < 0) {
    throw new Error(
      `computeAmendment: deposit paid must be a finite, non-negative number (got ${depositPaid})`,
    );
  }
  // Guard the prior figures too: a NaN previous total would silently poison the
  // delta (and `requiresReconsent` would then read a real change as cosmetic — a
  // quiet money-safety hole). These come from the persisted order, so a bad value
  // is a data/programmer error, not a user one.
  if (!Number.isFinite(previousTotal) || previousTotal < 0) {
    throw new Error(
      `computeAmendment: previous total must be a finite, non-negative number (got ${previousTotal})`,
    );
  }
  if (!Number.isFinite(previousBalance)) {
    throw new Error(
      `computeAmendment: previous balance must be a finite number (got ${previousBalance})`,
    );
  }

  const prevTotal = round2(previousTotal);
  const deposit = round2(depositPaid);
  const newTotalR = round2(newTotal);
  const delta = round2(newTotalR - prevTotal);

  // Balance = new total − deposit already paid, clamped at ≥ 0.
  const rawBalance = round2(newTotalR - deposit);
  const newBalance = Math.max(0, rawBalance);

  const entry: AmendmentTrailEntry = {
    amended_at: (input.now ? input.now() : new Date()).toISOString(),
    by,
    reason,
    previous_total: prevTotal,
    new_total: newTotalR,
    previous_balance: round2(previousBalance),
    new_balance: newBalance,
    deposit_applied: deposit,
    delta,
    line_item_changes: input.lineItemChanges ?? [],
  };

  // Overpayment: the deposit already exceeds the new total. Surface the credit
  // for a manual Valor refund (consistent with the cancellation decision —
  // refunds stay manual, no integration to build).
  if (rawBalance < 0) {
    entry.credit_note = round2(-rawBalance);
    entry.overpayment = true;
  }

  return entry;
}

/**
 * Re-consent DEFAULT (SPEC §9 is UNDECIDED — Naldo must confirm). An amendment
 * that CHANGES the total requires the customer to re-approve the new total
 * (re-sign) before any balance change is charged; a zero-delta (cosmetic)
 * amendment does not. Encoded here as a pure predicate. Sub-cent deltas count as
 * zero (float dust on a re-priced selection is not a real price change).
 */
export function requiresReconsent(amendment: AmendmentTrailEntry): boolean {
  return Math.abs(amendment.delta) >= ONE_CENT;
}

/**
 * The QuoteStatus an amendment resolves to. A total-changing amendment moves the
 * order into the re-consent status (it awaits the customer re-approving the new
 * total); a zero-delta amendment leaves the current status untouched.
 *
 * REUSES the existing `changes_requested` status rather than adding an `amending`
 * state — `changes_requested` already means "back in staff/customer hands, not a
 * settled booking", and reusing it avoids editing the shared quoteStatus.ts
 * table the whole #83 stack depends on. (Flagged decision: if the operator UX
 * later needs to distinguish "customer-requested change" from "staff-amended,
 * awaiting re-sign", a dedicated `amending` status would be added to
 * quoteStatus.ts THEN — not here.)
 */
export const AMEND_RECONSENT_STATUS: QuoteStatus = 'changes_requested';

export function amendedQuoteStatus(
  amendment: AmendmentTrailEntry,
  currentStatus: QuoteStatus,
): QuoteStatus {
  return isAmendmentConsentPending(amendment) ? AMEND_RECONSENT_STATUS : currentStatus;
}

/**
 * The most recently appended entry in an amendment trail, or null when the
 * quote has never been amended. Amendments are APPEND-ONLY (the amend route
 * never reorders or removes one), so the last array element is always latest.
 */
export function latestAmendment(
  amendments: AmendmentTrailEntry[] | null | undefined,
): AmendmentTrailEntry | null {
  if (!Array.isArray(amendments) || amendments.length === 0) return null;
  return amendments[amendments.length - 1];
}

/**
 * Return the newest total-changing amendment, ignoring later cosmetic entries.
 *
 * Consent belongs to the latest price change, not necessarily the final audit
 * entry. A later zero-dollar scope edit must not hide pending consent, unblock
 * settlement, or make an accepted amended total disappear from the portal.
 */
export function latestConsentAmendment(
  amendments: AmendmentTrailEntry[] | null | undefined,
): AmendmentTrailEntry | null {
  if (!Array.isArray(amendments)) return null;
  for (let index = amendments.length - 1; index >= 0; index -= 1) {
    if (requiresReconsent(amendments[index])) return amendments[index];
  }
  return null;
}

/**
 * True whenever the customer has NOT accepted (signed) the latest
 * total-changing amendment — whether because they haven't answered yet
 * (`consent` missing/`'pending'`) OR because they explicitly DECLINED it.
 * Deliberately does not distinguish those two: a decline is a customer
 * saying no, not a customer saying nothing, but for every caller of this
 * predicate (the portal's "is there a live ask" gate, and blocksSettlement
 * below) "not accepted" is the exact question being asked — a decline must
 * keep blocking settlement exactly as hard as an un-answered pending entry
 * does, per the review note on blocksSettlement below. Callers that need to
 * tell pending apart from declined (the portal card's copy, the admin trail
 * display) read `amendment.consent?.status` directly instead of adding a
 * second predicate here.
 */
export function isAmendmentConsentPending(
  amendment: AmendmentTrailEntry | null | undefined,
): boolean {
  return (
    !!amendment &&
    requiresReconsent(amendment) &&
    amendment.consent?.status !== 'accepted'
  );
}

/**
 * WT-18 — the settlement re-consent gate. mark-paid / charge-balance /
 * job-close all call this before moving money, on the quote's LATEST
 * amendment (via latestAmendment).
 *
 * `requiresReconsent` is true for ANY total-changing amendment — increase OR
 * decrease — because the PORTAL re-consent flow that predicate backs cares
 * about both directions (the customer re-signs either way). A SETTLEMENT gate
 * is narrower: it exists only to stop collecting/settling an un-consented
 * price INCREASE (the amend-up silently reopens the invoice to
 * awaiting_payment with zero proof the customer agreed to owe more). A
 * decrease can never over-collect, so it must NOT block — gating it would
 * strand a legitimate lower payment behind a re-sign nobody needs.
 *
 * True only when both hold: the delta is a real change and NOT accepted (via
 * isAmendmentConsentPending — pending OR declined both count) AND it is a
 * positive delta (the customer owes MORE than the last total they're on
 * record as having agreed to).
 *
 * A DECLINED increase is the money-critical case this must get right: the
 * customer said no, so the old (lower) total is still what they agreed to —
 * this must keep blocking exactly as hard as it did while pending, and it
 * does, because isAmendmentConsentPending reads 'declined' as "not accepted"
 * same as 'pending'. Only a NEW amendment (staff re-pricing down in the
 * builder and recording it) or the customer actually ACCEPTING can lift this.
 */
export function blocksSettlement(amendment: AmendmentTrailEntry | null | undefined): boolean {
  return !!amendment && isAmendmentConsentPending(amendment) && amendment.delta > 0;
}

// #83 Phase 4 + #81: the amend route + UI (which wire this lib) are LIVE. The
// operator "Edit booking" route (src/app/api/quotes/[id]/amend/route.ts) and
// its UI are money-moving operator surfaces — they re-open a BOOKED order,
// append the trail entry from computeAmendment() to
// approval_snapshot.amendments[] (WITHOUT overwriting the original signed
// snapshot), update the linked invoice balance, and — per the re-consent
// default above — re-notify / re-collect the customer's re-approval on a total
// change before charging the new balance. That route also REJECTs amendments
// on a non-booked order (only a booked order has a paid deposit to apply). All
// of it sits behind the #81 auth perimeter (requireOperator()).
//
// WT-18: `requiresReconsent` used to be advisory-only (surfaced in the amend
// route's JSON response, never enforced) and `amendedQuoteStatus` had zero
// production call sites. Both now drive the settlement gate — mark-paid,
// charge-balance, and job-close (src/app/api/invoices/[id]/mark-paid,
// .../charge-balance, src/app/api/jobs/[id]/close) each read the quote's
// approval_snapshot.amendments, take latestAmendment(), and call
// blocksSettlement() before moving money; a blocked settlement's error log
// also surfaces amendedQuoteStatus() so the operator sees the conceptual
// re-consent state without it ever being persisted (booked→changes_requested
// stays illegal — unchanged from the amend route's own design above). An
// operator override (`overrideReconsent`/`?override=true`) is the release
// valve; a real customer-facing re-approval flow is a separate, later piece
// of work.
