'use client';

// Ledger row 239 — client-side autosave of the portal's browsing selection to
// POST /api/quotes/[id]/selection. The client sibling of usePartialCapture
// (src/lib/leads/usePartialCapture.ts): debounced on change, one more attempt
// on page-leave via sendBeacon. See SelectionContext.tsx for the caller and
// src/lib/portal/adapter.ts's resolveBrowsingSelectionSeed for how a saved
// selection is reconciled back against live data on the NEXT visit — this
// hook only ever WRITES, it never reads.
//
// WHY debounced + dedup-by-value, not a write per click: the route is public,
// unauthenticated-by-design (the quote UUID in the URL is the capability
// token — see operatorGate's PUBLIC_QUOTE_SUBROUTES). A write per click would
// be a free write amplifier for anyone holding the link. Debouncing collapses
// a burst of toggles into one write ~1.5s after the customer settles, and
// seeding the dedup key from the INITIAL (already-seeded) selection means a
// customer who opens the portal and changes nothing — the overwhelming
// majority of opens — never triggers a write at all, not even one that would
// just resave what was already there.

import { useEffect, useRef } from 'react';

export type PersistedSelectionFields = {
  packageId: string;
  selectedItemIds: string[];
  rushSelected: boolean;
  takedownSelected: boolean;
  installTiming: string;
  colorSchemeId: string;
  customPattern: string[];
  permanentEffect: string;
};

// Stable dedup key: order-independent for the two array fields (a toggle
// on/off/on landing back at the same SET shouldn't count as "changed" just
// because Set iteration order shifted). Exported for pure-logic testing (the
// house convention — no jsdom/hook-rendering test needed for this).
export function selectionKey(f: PersistedSelectionFields): string {
  return JSON.stringify({
    packageId: f.packageId,
    selectedItemIds: [...f.selectedItemIds].sort(),
    rushSelected: f.rushSelected,
    takedownSelected: f.takedownSelected,
    installTiming: f.installTiming,
    colorSchemeId: f.colorSchemeId,
    customPattern: f.customPattern,
    permanentEffect: f.permanentEffect,
  });
}

const SAVE_DEBOUNCE_MS = 1500;

export function usePersistedSelection(opts: {
  // false when the quote is locked (approved/booked — the frozen snapshot is
  // the durable record from here on) or there's no real quoteId (the mock/dev
  // fallback has none — see SelectionProviderProps.quoteId).
  enabled: boolean;
  quoteId: string | undefined;
  fields: PersistedSelectionFields;
}): void {
  // Everything the deferred send() reads goes through a ref, so the mount-once
  // page-leave listener and the debounce timer always see the LATEST values
  // without re-subscribing every render — same pattern usePartialCapture uses.
  const fieldsRef = useRef(opts.fields);
  const enabledRef = useRef(opts.enabled);
  const quoteIdRef = useRef(opts.quoteId);
  useEffect(() => {
    fieldsRef.current = opts.fields;
    enabledRef.current = opts.enabled;
    quoteIdRef.current = opts.quoteId;
  });

  // Seeded to the INITIAL selection (whatever the portal opened on — the
  // staff default, an approval, or an already-reconciled prior save) so
  // opening the portal and changing nothing never re-writes the value it just
  // read. Computed once via useRef's lazy-init argument.
  const lastSavedKeyRef = useRef<string>(selectionKey(opts.fields));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function send(useBeacon: boolean) {
    if (!enabledRef.current) return;
    const id = quoteIdRef.current;
    if (!id) return;
    const key = selectionKey(fieldsRef.current);
    if (key === lastSavedKeyRef.current) return; // unchanged since the last save — skip
    lastSavedKeyRef.current = key;
    const body = JSON.stringify(fieldsRef.current);
    const url = `/api/quotes/${id}/selection`;
    if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        // text/plain (not application/json) keeps this a CORS-simple request —
        // the route parses the body regardless of content-type, same as
        // usePartialCapture's beacon.
        navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
      } catch {
        /* best-effort — a failed beacon is never surfaced to the customer */
      }
      return;
    }
    void fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(
      () => {
        /* best-effort — persistence never bothers the customer */
      },
    );
  }

  // Debounced save: fires ~1.5s after the last selection-affecting change
  // settles. Re-runs whenever the selection's dedup key, enabled, or quoteId
  // changes — NOT on every render (fields is read fresh via the ref above).
  const key = selectionKey(opts.fields);
  useEffect(() => {
    if (!enabledRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => send(false), SAVE_DEBOUNCE_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [key, opts.enabled, opts.quoteId]);

  // One more attempt on page-leave (mirrors usePartialCapture) so a customer
  // who toggles something and immediately closes the tab — before the debounce
  // timer would have fired — still gets it saved.
  useEffect(() => {
    function onLeave() {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      send(true);
    }
    function onVisibility() {
      if (document.visibilityState === 'hidden') onLeave();
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onLeave);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onLeave);
    };
    // Mount-once: onLeave reads live state through the refs above, so it never
    // needs to re-subscribe.
  }, []);
}
