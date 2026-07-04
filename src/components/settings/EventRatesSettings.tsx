'use client';

// Event Lighting rates editor (Settings → Quotes). Adjusts the event pricing
// engine's rate table (app_settings.eventRates) without a deploy — the #101
// pattern. Loads via GET /api/settings, saves via PUT { eventRates }. The server
// sanitizes each field (invalid/≤0 → default), and we re-hydrate from the saved
// result so what you see is exactly what will price.

import { useEffect, useState } from 'react';
import { DEFAULT_EVENT_RATES, type EventRates } from '@/lib/event/types';

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
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <label className="flex items-center justify-between gap-3 py-1.5">
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

export function EventRatesSettings() {
  const [rates, setRates] = useState<EventRates>(DEFAULT_EVENT_RATES);
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
        if (data?.eventRates) setRates(data.eventRates as EventRates);
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

  function update(next: EventRates) {
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
        body: JSON.stringify({ eventRates: rates }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Save failed (${res.status})`);
      }
      const data = await res.json();
      if (data?.eventRates) setRates(data.eventRates as EventRates);
      setStatus('saved');
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setStatus('error');
    }
  }

  if (status === 'loading') {
    return <p className="text-sm text-gray-500">Loading event rates…</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Event lighting rates</h2>
        <p className="mt-0.5 text-sm text-gray-500">
          Pricing for event (temporary) quotes. Separate from Christmas and permanent rates. A blank
          or zero value resets to the default on save.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Section title="C9 rooflines ($/ft)">
          <RateField
            label="Easy"
            value={rates.roofline.easy}
            onChange={(v) => update({ ...rates, roofline: { ...rates.roofline, easy: v } })}
            suffix="/ft"
          />
          <RateField
            label="Medium"
            value={rates.roofline.medium}
            onChange={(v) => update({ ...rates, roofline: { ...rates.roofline, medium: v } })}
            suffix="/ft"
          />
          <RateField
            label="Hard"
            value={rates.roofline.hard}
            onChange={(v) => update({ ...rates, roofline: { ...rates.roofline, hard: v } })}
            suffix="/ft"
          />
        </Section>

        <Section title="Mini lights ($/string)">
          <RateField
            label="Canopy (bush / column / railing / curtain)"
            value={rates.mini.canopy}
            onChange={(v) => update({ ...rates, mini: { ...rates.mini, canopy: v } })}
            suffix="/string"
          />
          <RateField
            label="Trunk (large trees)"
            value={rates.mini.trunk}
            onChange={(v) => update({ ...rates, mini: { ...rates.mini, trunk: v } })}
            suffix="/string"
          />
        </Section>

        <Section title="Spritzers ($ each)">
          <RateField
            label='16"'
            value={rates.spritzer['16']}
            onChange={(v) => update({ ...rates, spritzer: { ...rates.spritzer, '16': v } })}
          />
          <RateField
            label='24"'
            value={rates.spritzer['24']}
            onChange={(v) => update({ ...rates, spritzer: { ...rates.spritzer, '24': v } })}
          />
          <RateField
            label='32"'
            value={rates.spritzer['32']}
            onChange={(v) => update({ ...rates, spritzer: { ...rates.spritzer, '32': v } })}
          />
        </Section>

        <Section title="Temporary extras">
          <RateField
            label="Bistro (temporary)"
            value={rates.bistroPerFt}
            onChange={(v) => update({ ...rates, bistroPerFt: v })}
            suffix="/ft"
          />
          <RateField
            label="Freestanding pole & base support"
            value={rates.barrelBoxPrice}
            onChange={(v) => update({ ...rates, barrelBoxPrice: v })}
            suffix="each"
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
          {status === 'saving' ? 'Saving…' : 'Save event rates'}
        </button>
        {status === 'saved' && <span className="text-sm text-emerald-600">Saved.</span>}
        {status === 'error' && error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
