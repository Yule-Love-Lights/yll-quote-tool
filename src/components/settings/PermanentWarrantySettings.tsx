'use client';

// Permanent "Your Protection" warranty copy (Settings → Quotes, #88 P6b-2). The
// eyebrow, heading, and six guarantee bullets shown on the permanent portal's
// Risk-Reversal card. Each bullet pairs with a FIXED icon by slot (see the hints);
// a blank slot is hidden. Mirrors the PermanentRatesSettings pattern:
// GET /api/settings → edit → PUT. The VERSION is server-managed — saving a copy
// change bumps it, and every already-approved quote keeps the version it froze, so
// an edit here never changes what a booked customer agreed to.
//
// Type-only import from lib/permanent/types (no server deps) keeps this bundle-safe.

import { useEffect, useState } from 'react';
import { DEFAULT_PERMANENT_WARRANTY, type PermanentWarranty } from '@/lib/permanent/types';

const BULLET_COUNT = 6;
// The fixed icon each bullet slot pairs with in RiskReversalPermanent, as a hint
// so the operator keeps the copy semantically aligned with its badge.
const BULLET_HINTS = [
  'Slot 1 · ∞ badge — the lifetime materials warranty (the legal term).',
  'Slot 2 · phone badge — app / color control.',
  'Slot 3 · eye-off badge — invisible by day.',
  'Slot 4 · house badge — no roof damage.',
  'Slot 5 · palette badge — everyday + holiday color.',
  'Slot 6 · shield badge — insurance / licensed + bonded.',
];

// Pad/truncate a bullets array to exactly BULLET_COUNT editable slots.
function toSlots(bullets: string[]): string[] {
  const out = bullets.slice(0, BULLET_COUNT);
  while (out.length < BULLET_COUNT) out.push('');
  return out;
}

export function PermanentWarrantySettings() {
  const [warranty, setWarranty] = useState<PermanentWarranty>(DEFAULT_PERMANENT_WARRANTY);
  const [bullets, setBullets] = useState<string[]>(toSlots(DEFAULT_PERMANENT_WARRANTY.bullets));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (!cancelled && res.ok && data.permanentWarranty) {
          const w = data.permanentWarranty as PermanentWarranty;
          setWarranty(w);
          setBullets(toSlots(w.bullets));
        }
      } catch {
        /* keep defaults on failure */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const setBullet = (i: number, v: string) =>
    setBullets((b) => b.map((t, idx) => (idx === i ? v : t)));

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          permanentWarranty: {
            eyebrow: warranty.eyebrow,
            heading: warranty.heading,
            bullets,
          },
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          window.location.href = `/login?from=${encodeURIComponent(window.location.pathname)}`;
          return;
        }
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      if (data.permanentWarranty) {
        const w = data.permanentWarranty as PermanentWarranty;
        setWarranty(w);
        setBullets(toSlots(w.bullets));
        setMsg(`Saved — warranty terms are now version ${w.version}.`);
      } else {
        setMsg('Saved.');
      }
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-gray-900">Permanent “Your Protection” card</h2>
        <span className="text-xs font-medium text-gray-500 whitespace-nowrap">
          Terms version {warranty.version}
        </span>
      </div>
      <p className="text-sm text-gray-500 mt-1">
        The eyebrow, heading, and six guarantee bullets on the permanent portal’s protection card.
        Leave a bullet blank to hide it. Saving a copy change bumps the terms version — quotes that
        customers have already approved keep the version they agreed to, so an edit here never
        changes a booked customer’s terms.
      </p>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Eyebrow</span>
          <input
            type="text"
            disabled={loading || busy}
            value={warranty.eyebrow}
            onChange={(e) => setWarranty((w) => ({ ...w, eyebrow: e.target.value }))}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:opacity-50"
          />
          <span className="text-xs text-gray-400">Small uppercase label above the heading.</span>
        </label>
        <label className="block">
          <span className="text-sm font-medium text-gray-700">Heading</span>
          <input
            type="text"
            disabled={loading || busy}
            value={warranty.heading}
            onChange={(e) => setWarranty((w) => ({ ...w, heading: e.target.value }))}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:opacity-50"
          />
          <span className="text-xs text-gray-400">The big section headline.</span>
        </label>
      </div>

      <div className="mt-4 space-y-3">
        {bullets.map((t, i) => (
          <label key={i} className="block">
            <span className="text-sm font-medium text-gray-700">Bullet {i + 1}</span>
            <textarea
              rows={2}
              disabled={loading || busy}
              value={t}
              onChange={(e) => setBullet(i, e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:opacity-50"
            />
            <span className="text-xs text-gray-400">{BULLET_HINTS[i]}</span>
          </label>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          disabled={loading || busy}
          onClick={save}
          className="bg-gray-900 hover:bg-black text-white font-medium text-sm px-4 py-2 rounded-md disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Save warranty copy'}
        </button>
        {msg && <span className="text-sm text-gray-700">{msg}</span>}
      </div>
    </div>
  );
}
