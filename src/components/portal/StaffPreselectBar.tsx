'use client';

// Ledger row 324 — the staff-only "Save as customer's starting selection"
// action. Rendered ONLY when page.tsx's server-side getOperator() check
// found a real authenticated operator session (never for a customer, and
// never for a staff device that merely carries the STAFF_DEVICE_COOKIE
// without being logged in) and the quote isn't already approved/booked
// (mirrors the write route's own 'locked' 409 — see staff-selection/route.ts).
//
// Reads the LIVE selection off the same <SelectionProvider> the customer's
// own controls write to, so staff configure the opening selection with the
// exact same package/item/colour UI a customer would use, then click Save
// to persist it via the operator-authed route (never the public
// /api/quotes/[id]/selection route, whose isStaffPreview skip stays
// untouched by this).

import { useState } from 'react';
import { useSelection } from './SelectionContext';

// Fix-round MED (staff lens): the fields the save persists, reduced to a
// stable string so the component can tell "the live selection is exactly
// what was last saved" from "staff changed something since". Extracted as a
// pure function (mirrors this file's siblings — nextSelectedItemIds,
// computeInitialSelection in SelectionContext.tsx — pure + unit-tested
// rather than exercised only through a rendered component) so equality
// logic doesn't drift from the payload save() actually POSTs.
export type StaffSelectionSnapshot = {
  packageId: string;
  selectedItemIds: Iterable<string>;
  rushSelected: boolean;
  takedownSelected: boolean;
  installTiming: string;
  colorSchemeId: string;
  customPattern: string[];
  permanentEffect: string;
};

export function staffSelectionSignature(s: StaffSelectionSnapshot): string {
  return JSON.stringify({
    packageId: s.packageId,
    // Sorted so the signature reflects WHICH items are selected, not the
    // Set's iteration order (order is otherwise insertion-dependent).
    selectedItemIds: [...s.selectedItemIds].sort(),
    rushSelected: s.rushSelected,
    takedownSelected: s.takedownSelected,
    installTiming: s.installTiming,
    colorSchemeId: s.colorSchemeId,
    customPattern: s.customPattern,
    permanentEffect: s.permanentEffect,
  });
}

export function StaffPreselectBar({
  quoteId,
  customerViewed,
}: {
  quoteId: string;
  // True when quote.viewedAt is set — the #68 view receipt, which /view
  // deliberately never stamps for a staff preview (isStaffPreview), so this
  // can only mean the real customer opened the link. The chosen "has the
  // customer already browsed?" signal for the overwrite confirm (see the
  // route header for why: it works uniformly for every row, old and new,
  // unlike the staffSet provenance this feature newly writes).
  customerViewed: boolean;
}) {
  const selection = useSelection();
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  // Fix-round MED (staff lens): the "Saved" confirmation used to stay lit
  // forever once shown, even after staff kept editing — so a staffer could
  // walk away trusting a stale confirmation while their newest edit was
  // never persisted. Instead of an effect that watches the selection and
  // resets state (fights the lint-as-error set-state-in-effect rule), the
  // save records a SIGNATURE of exactly what it persisted; the confirmation
  // renders only while the live selection still matches that signature — any
  // edit afterward changes the signature and the confirmation drops on its
  // own, during the very next render.
  const [savedSignature, setSavedSignature] = useState<string | null>(null);

  const currentSignature = staffSelectionSignature(selection);
  const showSaved = status === 'saved' && savedSignature === currentSignature;

  const save = async () => {
    if (customerViewed) {
      const proceed = window.confirm('The customer has already made choices — overwrite them?');
      if (!proceed) return;
    }
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/staff-selection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          packageId: selection.packageId,
          selectedItemIds: [...selection.selectedItemIds],
          rushSelected: selection.rushSelected,
          takedownSelected: selection.takedownSelected,
          installTiming: selection.installTiming,
          colorSchemeId: selection.colorSchemeId,
          customPattern: selection.customPattern,
          permanentEffect: selection.permanentEffect,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Could not save the selection');
      setSavedSignature(currentSignature);
      setStatus('saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the selection');
      setStatus('error');
    }
  };

  return (
    <div
      className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-amber-300/40 bg-slate-950/95 px-4 py-2 text-sm text-slate-100 backdrop-blur"
      role="region"
      aria-label="Staff preview"
    >
      <span className="font-semibold uppercase tracking-[0.15em] text-amber-300">Staff preview</span>
      <div className="flex items-center gap-3">
        {showSaved && (
          <span className="text-emerald-300">Saved as the customer&apos;s starting selection.</span>
        )}
        {status === 'error' && error && (
          <span role="alert" className="text-red-300">
            {error}
          </span>
        )}
        <button
          type="button"
          onClick={save}
          disabled={status === 'saving'}
          className="rounded-md bg-amber-400 px-3 py-1.5 font-semibold text-slate-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : "Save as customer's starting selection"}
        </button>
      </div>
    </div>
  );
}
