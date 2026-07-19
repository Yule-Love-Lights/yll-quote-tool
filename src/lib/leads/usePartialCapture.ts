'use client';

// Client-side partial / abandoned-form capture for the app's React forms
// (quote-forms-partial-save) — the React sibling of the vanilla-JS capture in
// public/lead-form.js. Saves whatever contact info the visitor has typed BEFORE
// they finish, so an abandoned form isn't a lost lead:
//   * debounced on field blur (call the returned `onBlur`), and
//   * once on page-leave (visibilitychange:hidden / pagehide → sendBeacon).
// It POSTs to /api/leads/partial, which keeps these OUT of the SMS drips — the
// visitor is never auto-texted until they actually submit (with consent, where
// the form requires it). Disable it (opts.enabled=false) once the real submit
// succeeds so a completed lead is never re-captured.

import { useEffect, useRef } from 'react';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE_MIN_DIGITS = 7;

export type PartialCaptureFields = {
  name?: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
};

export function usePartialCapture(opts: {
  enabled: boolean;
  source: string;
  formVariant: string;
  service?: string;
  fields: PartialCaptureFields;
}): { onBlur: () => void } {
  // Everything the deferred capture() reads goes through a ref, so the single
  // mount-time page-leave listener (and the debounce timer) always sees the
  // latest values without re-subscribing every render. The refs are synced in
  // an effect (writing ref.current during render is disallowed here).
  const fieldsRef = useRef(opts.fields);
  const enabledRef = useRef(opts.enabled);
  const cfgRef = useRef({ source: opts.source, formVariant: opts.formVariant, service: opts.service });
  useEffect(() => {
    fieldsRef.current = opts.fields;
    enabledRef.current = opts.enabled;
    cfgRef.current = { source: opts.source, formVariant: opts.formVariant, service: opts.service };
  });

  const captureIdRef = useRef<string | null>(null);
  const lastKeyRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function buildPayload(): Record<string, unknown> | null {
    const f = fieldsRef.current;
    const email = (f.email ?? '').trim();
    const phone = (f.phone ?? '').trim();
    const hasEmail = EMAIL_RE.test(email);
    const hasPhone = (phone.match(/\d/g) ?? []).length >= PHONE_MIN_DIGITS;
    if (!hasEmail && !hasPhone) return null; // a lone name isn't a lead yet
    const cfg = cfgRef.current;
    return {
      captureId: captureIdRef.current ?? undefined,
      name: (f.name ?? '').trim() || undefined,
      email: hasEmail ? email : undefined,
      phone: phone || undefined,
      address: (f.address ?? '').trim() || undefined,
      notes: (f.notes ?? '').trim() || undefined,
      service: cfg.service,
      formVariant: cfg.formVariant,
      source: cfg.source,
      landingUrl: typeof location !== 'undefined' ? location.href.slice(0, 1000) : undefined,
    };
  }

  function capture(useBeacon: boolean) {
    if (!enabledRef.current) return;
    const payload = buildPayload();
    if (!payload) return;
    const key = [payload.name, payload.email, payload.phone, payload.address, payload.notes].join('|');
    // Skip an unchanged repeat — applies to the page-leave beacon too, so a
    // single navigation firing BOTH visibilitychange:hidden and pagehide can't
    // write the same partial twice. A beacon with genuinely new data still has
    // a fresh key and goes through.
    if (key === lastKeyRef.current) return;
    lastKeyRef.current = key;
    const body = JSON.stringify(payload);
    const url = '/api/leads/partial';
    // text/plain keeps this a CORS-simple request; the route parses the body
    // regardless of content-type.
    if (useBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        navigator.sendBeacon(url, new Blob([body], { type: 'text/plain' }));
      } catch {
        /* best-effort — a failed beacon is never surfaced */
      }
      return;
    }
    void fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: true })
      .then((res) => res.json().catch(() => ({}) as { id?: unknown }))
      .then((data: { id?: unknown }) => {
        if (typeof data.id === 'string') captureIdRef.current = data.id;
      })
      .catch(() => {
        /* silent — partial capture never bothers the visitor */
      });
  }

  function onBlur() {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => capture(false), 800);
  }

  useEffect(() => {
    function onLeave() {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      capture(true);
    }
    function onVisibility() {
      if (document.visibilityState === 'hidden') onLeave();
    }
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onLeave);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onLeave);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // Mount-once: the listener reads live state through refs, so it never needs
    // to re-subscribe. capture/onLeave are stable closures over those refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { onBlur };
}
