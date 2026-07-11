'use client';

// Permanent Bistro Lighting rates editor (Settings → Quotes, #117). Adjusts the
// permanent-bistro pricing engine's rate table (app_settings.permanentBistroRates)
// without a deploy — the #101 pattern. Loads via GET /api/settings, saves via
// PUT { permanentBistroRates }. The server sanitizes each field (invalid/≤0 →
// default for perFt/perPole; minimum stays 0 when set — the gate-off value),
// and we re-hydrate from the saved result so what you see is exactly what will
// price. Mirrors EventRatesSettings.tsx.

import { useEffect, useState } from 'react';
import { DEFAULT_PERMANENT_BISTRO_RATES, type PermanentBistroRates } from '@/lib/permanentBistro/types';

type Status = 'loading' | 'idle' | 'saving' | 'saved' | 'error';

function toNum(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function RateField({
  label,
  value,
  onChange,
  suffix,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  hint?: string;
}) {
  return (
    <label className="block py-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-gray-700">{label}</span>
        <span className="inline-flex items-center gap-1">
          <span className="text-sm text-gray-400">$</span>
          <input
            type="number"
            min={0}
            step="1"
            value={value}
            onChange={(e) => onChange(toNum(e.target.value))}
            className="w-24 rounded border border-gray-300 px-2 py-1 text-right text-sm"
          />
          {suffix ? <span className="text-xs text-gray-400">{suffix}</span> : null}
        </span>
      </div>
      {hint ? <p className="mt-0.5 text-xs text-gray-400">{hint}</p> : null}
    </label>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 p-4">
      <h3 className="mb-1 text-sm font-semibold text-gray-900">{title}</h3>
      <div className="divide-y divide-gray-100">{children}</div>
    </div>
  );
}

export function PermanentBistroRatesSettings() {
  const [rates, setRates] = useState<PermanentBistroRates>(DEFAULT_PERMANENT_BISTRO_RATES);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) throw new Error(`Couldn't load settings (${res.status})`);
        const data = await res.json();
        if (!active) return;
        if (data?.permanentBistroRates) setRates(data.permanentBistroRates as PermanentBistroRates);
        setStatus('idle');
      } catch (e) {
        if (active) {
          setError(e instanceof Error ? e.message : 'Load failed');
          setStatus('error');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  function update(next: PermanentBistroRates) {
    setRates(next);
    setDirty(true);
    if (status === 'saved') setStatus('idle');
  }

  async function save() {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ permanentBistroRates: rates }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Save failed (${res.status})`);
      }
      const data = await res.json();
      if (data?.permanentBistroRates) setRates(data.permanentBistroRates as PermanentBistroRates);
      setStatus('saved');
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setStatus('error');
    }
  }

  if (status === 'loading') {
    return <p className="text-sm text-gray-500">Loading bistro lighting rates…</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Bistro Lighting (permanent)</h2>
        <p className="mt-0.5 text-sm text-gray-500">
          Pricing for permanent bistro quotes — café string lights on permanent poles/supports.
          Separate from Christmas, permanent roofline, and event rates. A blank or zero perFt/perPole
          value resets to the default on save.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Section title="Bistro lighting">
          <RateField
            label="Bistro lighting"
            value={rates.perFt}
            onChange={(v) => update({ ...rates, perFt: v })}
            suffix="/ft"
          />
          <RateField
            label="Permanent pole & support"
            value={rates.perPole}
            onChange={(v) => update({ ...rates, perPole: v })}
            suffix="each"
          />
        </Section>

        <Section title="Approval gate">
          <RateField
            label="Job minimum (approval gate)"
            value={rates.minimum}
            onChange={(v) => update({ ...rates, minimum: v })}
            hint="Portal approval gate — a selection under this can't be approved. Not a price floor. 0 turns the gate off."
          />
        </Section>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={status === 'saving' || !dirty}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : 'Save bistro rates'}
        </button>
        {status === 'saved' && <span className="text-sm text-emerald-600">Saved.</span>}
        {status === 'error' && error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
