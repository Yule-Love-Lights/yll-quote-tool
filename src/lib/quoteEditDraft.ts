// Row 413 — edit-mode autosave for the quote builder.
//
// Row 406 shipped a dirty-state banner plus `beforeunload`, which covers an
// accidental refresh, a tab close, and leaving for another site. It does NOT
// cover the two doors that remain, both real: (a) IN-APP navigation — every
// OperatorNav link is a next/link client transition that unmounts the builder
// without firing beforeunload, and clicking Inbox mid-edit is ordinary; and
// (b) a silent Chrome Memory Saver tab discard, which never runs the handler
// at all — the trigger that could not be ruled out for the original confirmed
// prod loss. localStorage survives both, so the un-Calculated edits do too.
//
// WHY THIS IS A SEPARATE MODULE FROM quoteDraft.ts, AND GATED DIFFERENTLY.
// The existing draft (quoteDraft.ts) is deliberately OFF for reopened quotes
// (`draftAutosaveActive`: reopen-safety), because blindly restoring a stashed
// form over a reopened quote is a CLOBBER RISK — the server row may have moved
// since the stash (another operator, another tab, an approval). This module
// exists to carry edit-mode drafts WITHOUT reopening that hole, by binding
// every draft to the server snapshot it was edited on top of:
//
//   - Each draft stores `base` — the stableStringify of the last-persisted
//     form at the moment of stashing (the same string the row-406 dirty check
//     compares against, so "what the draft is on top of" and "what dirty
//     means" cannot drift apart).
//   - On reopen, the draft is offered ONLY when the freshly-loaded server form
//     serializes to that same `base`. If the row moved — anyone saved anything
//     since — the draft is silently dropped: the server won, exactly the
//     outcome the reopen-safety gate exists to force. This is the localStorage
//     analogue of the approval_snapshot value-CAS.
//   - Restoring is an OFFER (a visible banner with Restore/Discard), never an
//     automatic write into form state. The operator says so first.
//
// Scope: the full QuoteFormData — the same object whose serialization defines
// dirty, so the draft covers exactly what the warning warns about, nothing
// more. Keyed per quote id so drafts on different quotes never overwrite each
// other; expired after the same 7 days as the new-quote draft (this is a
// convenience stash on a staff machine, not a durable store of customer PII);
// cleared the moment a Calculate actually persists.

import type { QuoteFormData } from './quoteForm';

const PREFIX = 'yll_quote_edit_draft_v1:';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type QuoteEditDraft = {
  form: QuoteFormData;
  /** stableStringify of the last-persisted form this draft was edited on top of. */
  base: string;
  /**
   * Row 420: the quote's LIFECYCLE at stash time (quoteEditDraftLifecycle of
   * status + customer_approved_at + deposit_paid_at). The `base` CAS above
   * only binds the draft to the FORM it was edited on top of — /approve and
   * the deposit webhook never touch inputs/result, so a draft stashed
   * pre-approval still base-matches after the customer approved or booked,
   * and offering it would push abandoned numbers onto a live booked order
   * (amendReprice fires unconditionally for booked). Binding the draft to
   * the lifecycle too makes such a draft DISCARDED at reopen, not offered.
   */
  lifecycle: string;
  savedAt: number;
};

/**
 * Row 420: the lifecycle stamp a draft is bound to. Timestamps, not the
 * derived status label, so a status-derivation change can never silently
 * un-bind old drafts; JSON of a fixed-key object so the comparison is exact.
 */
export function quoteEditDraftLifecycle(q: {
  status: string | null;
  approvedAt: string | null;
  depositPaidAt: string | null;
}): string {
  return JSON.stringify({
    status: q.status ?? null,
    approvedAt: q.approvedAt ?? null,
    depositPaidAt: q.depositPaidAt ?? null,
  });
}

function hasWindow(): boolean {
  return typeof window !== 'undefined' && !!window.localStorage;
}

function keyFor(quoteId: string): string {
  return PREFIX + quoteId;
}

export function saveQuoteEditDraft(quoteId: string, form: QuoteFormData, base: string, lifecycle: string): void {
  if (!hasWindow()) return;
  try {
    const draft: QuoteEditDraft = { form, base, lifecycle, savedAt: Date.now() };
    window.localStorage.setItem(keyFor(quoteId), JSON.stringify(draft));
  } catch {
    /* private mode / storage full — the stash is best-effort; the row-406
       banner and beforeunload are still on duty. */
  }
}

/**
 * The stashed draft for this quote, or null. `currentBase` is the
 * stableStringify of the form as freshly seeded from the SERVER on this mount
 * — the draft is returned only if it was edited on top of exactly that value.
 * A mismatch means the row moved since the stash (someone saved), and the
 * draft is cleared rather than offered: restoring it would clobber newer
 * work, which is the precise failure the reopen-safety gate on the old
 * new-quote draft exists to prevent.
 */
export function loadQuoteEditDraft(
  quoteId: string,
  currentBase: string,
  currentLifecycle: string,
): QuoteEditDraft | 'server-moved' | 'lifecycle-moved' | null {
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(keyFor(quoteId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QuoteEditDraft>;
    const savedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : 0;
    if (!savedAt || Date.now() - savedAt > MAX_AGE_MS) {
      clearQuoteEditDraft(quoteId);
      return null;
    }
    if (typeof parsed.base !== 'string' || !parsed.form || typeof parsed.form !== 'object') {
      clearQuoteEditDraft(quoteId);
      return null;
    }
    // Row 420: a draft with no lifecycle stamp (stashed before this shipped)
    // cannot be verified against the live quote's state, and the unverifiable
    // case IS the dangerous one (a pre-approval stash on a now-booked order).
    // Cleared silently, not with the 'lifecycle-moved' notice — that notice
    // claims the order's state moved, which a missing stamp can't establish.
    // One-time migration cost, bounded by the 7-day TTL anyway.
    if (typeof parsed.lifecycle !== 'string') {
      clearQuoteEditDraft(quoteId);
      return null;
    }
    if (parsed.lifecycle !== currentLifecycle) {
      // Row 420: the quote's LIFECYCLE moved since the stash — approved,
      // booked, declined, un-approved — even though the priced form itself
      // (`base`) still matches. Offering the draft would let Calculate push
      // pre-approval numbers onto a live order whose state the operator has
      // no hint moved. DISCARD, and tell the operator why (same reasoning as
      // 'server-moved': a silent drop reads as the tool eating work).
      clearQuoteEditDraft(quoteId);
      return 'lifecycle-moved';
    }
    if (parsed.base !== currentBase) {
      // The server row moved since this draft was stashed. The server wins —
      // but the operator is TOLD (PR #972 staff lens MED: a silent drop reads
      // as "the tool ate my work", indistinguishable from a bug). The draft
      // itself is still cleared; 'server-moved' only drives an info notice.
      clearQuoteEditDraft(quoteId);
      return 'server-moved';
    }
    return { form: parsed.form as QuoteFormData, base: parsed.base, lifecycle: parsed.lifecycle, savedAt };
  } catch {
    return null;
  }
}

export function clearQuoteEditDraft(quoteId: string): void {
  if (!hasWindow()) return;
  try {
    window.localStorage.removeItem(keyFor(quoteId));
  } catch {
    /* ignore */
  }
}

/**
 * Drop every expired edit draft (any quote). Run once per builder mount so
 * drafts for quotes nobody reopens don't sit in localStorage past the TTL —
 * the per-quote load() only ever sweeps its own key.
 */
export function sweepQuoteEditDrafts(): void {
  if (!hasWindow()) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(PREFIX)) continue;
      try {
        const parsed = JSON.parse(window.localStorage.getItem(key) ?? '') as Partial<QuoteEditDraft>;
        const savedAt = typeof parsed.savedAt === 'number' ? parsed.savedAt : 0;
        if (!savedAt || Date.now() - savedAt > MAX_AGE_MS) doomed.push(key);
      } catch {
        doomed.push(key); // unparseable stash is garbage — drop it
      }
    }
    for (const key of doomed) window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/**
 * "5 minutes ago" / "2 hours ago" / "yesterday" / "3 days ago" — the recovered
 * banner's plain-language age. Coarse on purpose: the operator needs "was this
 * just now or last week", not a timestamp.
 */
export function formatDraftAge(savedAt: number, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - savedAt) / 60000));
  if (mins < 1) return 'moments ago';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
