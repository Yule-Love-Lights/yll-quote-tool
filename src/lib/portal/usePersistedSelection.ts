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

// FIX (row 239 fix round 2, delta-verify HIGH) — pure decision for whether a
// send should actually go out for `key`, given the last CONFIRMED-saved key
// and the set of keys that currently have a request in flight.
//
// This replaces round 1's model (an optimistic claim + revert-on-failure via
// a since-removed dedupKeyAfterFailedSave helper), which the delta-verify
// proved loses data on two CONSECUTIVE failures — an ordinary flaky-mobile
// sequence, not an exotic race:
//   1. Selection -> A. send() claims the slot, captures priorKey K0. Fetch A
//      is dispatched, slow.
//   2. Selection -> B before A resolves. send() claims the slot, captures
//      priorKey A.
//   3. Fetch A fails. The CAS sees the slot now holds B (not A) -> correctly
//      no-ops (something newer already claimed it).
//   4. Fetch B fails. The CAS sees the slot holds B -> reverts the slot to A.
//   5. The slot now reads A — but A was never actually saved either; the
//      server still holds K0.
//   6. The customer flips back to A (an ordinary compare-two-options
//      gesture). key === the slot's value -> the write is skipped, and the
//      true state (A) is never saved for the rest of that page's life.
// Root cause: reverting to "whatever the slot held before this attempt" is
// memoryless about whether THAT value was itself ever confirmed saved, or
// was just another failed attempt that got out-run by a newer one.
//
// This model can't have that property: lastConfirmedKeyRef (below, in the
// hook) is written in exactly ONE place — an actual confirmed success —
// never as a side effect of a failure or a revert. A key that was never
// confirmed saved can therefore never equal lastConfirmedKeyRef, so the next
// discrete event (a debounce settle or a page-leave) that computes that same
// key always sees it as "changed" and retries it. Re-tracing the six steps
// above under this model: at no point does anything ever assign
// lastConfirmedKeyRef to A or B (both attempts failed), so it stays K0
// throughout. Step 6 computes key=A, A !== K0, nothing is in flight for A
// any more (both requests already settled) -> it sends. No step loses data,
// regardless of how many consecutive failures precede it.
//
// inFlightKeys exists purely to stop a SECOND concurrent request for the
// IDENTICAL value — e.g. a debounce-triggered fetch still in flight when the
// page-leave beacon fires moments later with the same, unchanged selection —
// it is not a retry mechanism and carries no memory once a request settles.
// A Set, not a single ref, because two DIFFERENT values can legitimately be
// in flight at once (steps 1–2 above: A and B both in flight together).
// Exported — same pure-logic-testing convention as selectionKey above —
// because this repo has no jsdom/hook-rendering test setup (verified: no
// jsdom/happy-dom/@testing-library/react in node_modules or package.json).
export function shouldSend(key: string, lastConfirmedKey: string, inFlightKeys: ReadonlySet<string>): boolean {
  if (key === lastConfirmedKey) return false; // unchanged since the last CONFIRMED save
  if (inFlightKeys.has(key)) return false; // a request for this exact value is already in flight
  return true;
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
  // read. Computed once via useRef's lazy-init argument. From here on it is
  // written in exactly ONE place — an actual confirmed successful save — see
  // the shouldSend comment above for why that single-writer property is what
  // makes the retry model safe against consecutive failures.
  const lastConfirmedKeyRef = useRef<string>(selectionKey(opts.fields));
  // Keys with a request currently in flight — see the shouldSend comment
  // above.
  const inFlightKeysRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function send(useBeacon: boolean) {
    if (!enabledRef.current) return;
    const id = quoteIdRef.current;
    if (!id) return;
    const key = selectionKey(fieldsRef.current);
    if (!shouldSend(key, lastConfirmedKeyRef.current, inFlightKeysRef.current)) return;
    const body = JSON.stringify(fieldsRef.current);
    const url = `/api/quotes/${id}/selection`;

    if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        // text/plain (not application/json) keeps this a CORS-simple request —
        // the route parses the body regardless of content-type, same as
        // usePartialCapture's beacon. sendBeacon resolves SYNCHRONOUSLY —
        // either the browser queues it for delivery (the best confirmation
        // signal available; there is no delivery callback) or it refuses,
        // which is a failure like any other. Queued -> confirmed, so
        // lastConfirmedKeyRef advances to this value; refused -> left
        // untouched, so the next debounce settle or page-leave retries it.
        const queued = navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
        if (queued) lastConfirmedKeyRef.current = key;
      } catch {
        // best-effort — a thrown sendBeacon is never surfaced to the
        // customer; lastConfirmedKeyRef is left untouched so this value is
        // retried by the next discrete send event.
      }
      return;
    }

    inFlightKeysRef.current.add(key);
    void fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
      .then((res) => {
        // Only a real 2xx counts as confirmed. On !res.ok, lastConfirmedKeyRef
        // is left untouched — never marked "saved" for a failed attempt — so
        // the next debounce settle or page-leave retries this same value.
        if (res.ok) lastConfirmedKeyRef.current = key;
      })
      .catch(() => {
        // best-effort — persistence never bothers the customer;
        // lastConfirmedKeyRef is left untouched so this value is retried.
      })
      .finally(() => {
        inFlightKeysRef.current.delete(key);
      });
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
      // FIX C (row 239 fix round) — clearing the pending timer BEFORE the
      // beacon fires means a beacon can never race an unfired debounce call:
      // there's only ever the ONE outbound request from this branch. The
      // residual out-of-order risk this can't remove — an OLDER fetch,
      // already in flight from a previous debounce settle, landing after this
      // beacon — is accepted; see the selection route's header for the full
      // reasoning.
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
