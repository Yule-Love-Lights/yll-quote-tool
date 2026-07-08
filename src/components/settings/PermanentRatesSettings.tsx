'use client';

// Permanent Lighting rates (Settings → Quotes, #88). The adjustable $/ft + job
// minimum + maintenance price the permanent pricing engine reads, plus the
// feature flag that turns the Permanent option on in the quote builder. Mirrors
// the #101 swatch-editor pattern: GET /api/settings → edit → PUT.
//
// Type-only import from lib/permanent/types (no server deps) keeps this
// client-bundle-safe.

import { useEffect, useState } from 'react';
import { DEFAULT_PERMANENT_RATES, type PermanentRates } from '@/lib/permanent/types';

const FIELDS: { key: keyof PermanentRates; label: string; hint: string }[] = [
  { key: 'frontPerFt', label: 'Front $/ft', hint: 'Retail rate for the front of the house.' },
  { key: 'sidesPerFt', label: 'Sides $/ft', hint: 'Left + right (billed together).' },
  { key: 'backPerFt', label: 'Back $/ft', hint: 'Retail rate for the back.' },
  { key: 'minimumJobAmount', label: 'Job minimum ($)', hint: 'Portal approval gate — a selection under this can’t be approved. Not a price floor. New quotes only: existing quotes keep the minimum they were created with.' },
  { key: 'maintenancePrice', label: 'Maintenance add-on ($)', hint: 'Annual maintenance plan price. 0 hides the add-on.' },
];

export function PermanentRatesSettings() {
  const [rates, setRates] = useState<PermanentRates>(DEFAULT_PERMANENT_RATES);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        if (!cancelled && res.ok) {
          if (data.permanentRates) setRates(data.permanentRates as PermanentRates);
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

  const setField = (k: keyof PermanentRates, raw: string) => {
    const n = Number(raw);
    setRates((r) => ({ ...r, [k]: Number.isFinite(n) && n >= 0 ? n : 0 }));
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ permanentRates: rates }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          window.location.href = `/login?from=${encodeURIComponent(window.location.pathname)}`;
          return;
        }
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      if (data.permanentRates) setRates(data.permanentRates as PermanentRates);
      setMsg('Saved.');
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-gray-900">Permanent lighting rates</h2>
      <p className="text-sm text-gray-500 mt-1">
        Per-foot retail rates, the job minimum, and the maintenance add-on price for permanent
        (Omni/Ascend) quotes. Changes here apply to <strong>new quotes only</strong> — every quote
        (including its job minimum) freezes these values when it’s first calculated, and
        re-calculating an existing quote re-prices from its own frozen copy, never from this page.
      </p>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        {FIELDS.map((f) => (
          <label key={f.key} className="block">
            <span className="text-sm font-medium text-gray-700">{f.label}</span>
            <input
              type="number"
              min={0}
              step="1"
              inputMode="decimal"
              disabled={loading || busy}
              value={String(rates[f.key])}
              onChange={(e) => setField(f.key, e.target.value)}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:opacity-50"
            />
            <span className="text-xs text-gray-400">{f.hint}</span>
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
          {busy ? 'Saving…' : 'Save permanent rates'}
        </button>
        {msg && <span className="text-sm text-gray-700">{msg}</span>}
      </div>
    </div>
  );
}
