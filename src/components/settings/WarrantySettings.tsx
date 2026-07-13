'use client';

// "Your Protection" warranty copy editor (Settings → Quotes). Generalizes the
// permanent-only editor (#88 P6b-2) to all four verticals (WT-56/65/07): the
// eyebrow, heading, and bullet copy shown on that vertical's portal Risk-
// Reversal card. Each bullet pairs with a FIXED icon by slot (see the caller's
// bulletHints); a blank slot is hidden. GET /api/settings → edit → PUT. The
// VERSION is server-managed — saving a copy change bumps it, and every already-
// approved quote keeps the version it froze, so an edit here never changes what
// a booked customer agreed to.
//
// One component, parameterized by settingsKey — mirrors the PortalSwatchEditor
// pattern (#88 P6b-4) for the same reason: four near-identical CRUD forms would
// otherwise drift out of sync with each other.

import { useEffect, useState } from 'react';
import type { ServiceWarranty } from '@/lib/warranty/types';

type WarrantySettingsKey = 'holidayWarranty' | 'eventWarranty' | 'bistroWarranty' | 'permanentWarranty';

type WarrantySettingsProps = {
  settingsKey: WarrantySettingsKey;
  title: string;
  description: string;
  defaultWarranty: ServiceWarranty;
  /** One hint per bullet slot — length determines how many bullet fields render. */
  bulletHints: string[];
};

// Pad/truncate a bullets array to exactly the slot count.
function toSlots(bullets: string[], count: number): string[] {
  const out = bullets.slice(0, count);
  while (out.length < count) out.push('');
  return out;
}

export function WarrantySettings({
  settingsKey,
  title,
  description,
  defaultWarranty,
  bulletHints,
}: WarrantySettingsProps) {
  const bulletCount = bulletHints.length;
  const [warranty, setWarranty] = useState<ServiceWarranty>(defaultWarranty);
  const [bullets, setBullets] = useState<string[]>(toSlots(defaultWarranty.bullets, bulletCount));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (!cancelled && res.ok && data[settingsKey]) {
          const w = data[settingsKey] as ServiceWarranty;
          setWarranty(w);
          setBullets(toSlots(w.bullets, bulletCount));
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
    // settingsKey/bulletCount are fixed per mount (each caller renders its own
    // instance with a stable key) — no need to re-run on their identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          [settingsKey]: {
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
      if (data[settingsKey]) {
        const w = data[settingsKey] as ServiceWarranty;
        setWarranty(w);
        setBullets(toSlots(w.bullets, bulletCount));
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
        <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
        <span className="text-xs font-medium text-gray-500 whitespace-nowrap">
          Terms version {warranty.version}
        </span>
      </div>
      <p className="text-sm text-gray-500 mt-1">{description}</p>

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
            <span className="text-xs text-gray-400">{bulletHints[i]}</span>
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
