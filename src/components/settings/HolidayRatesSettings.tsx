'use client';

// Holiday Lighting rates editor (Settings → Quotes, WT-63). Adjusts the holiday
// pricing engine's rate table (app_settings.holidayRates) without a deploy —
// mirrors EventRatesSettings/PermanentRatesSettings (the #101 pattern). Loads via
// GET /api/settings, saves via PUT { holidayRates }. The server sanitizes every
// field (invalid/out-of-range → default), and we re-hydrate from the saved
// result so what you see is exactly what will price.
//
// Changes here apply to NEW quotes only — every quote freezes these values into
// its own `holidayRatesSnapshot` when it's first calculated, and re-calculating
// an existing quote re-prices from its own frozen copy, never from this page
// (the same rate-drift guard permanent/event/bistro already use).

import { useEffect, useState } from 'react';
import { DEFAULT_HOLIDAY_RATES, type HolidayRates, type WreathSize, type GarlandLength } from '@/lib/pricing/pricingEngine';

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

const WREATH_SIZES: { key: WreathSize; label: string }[] = [
  { key: '24noble', label: '24" Noble' },
  { key: '30noble', label: '30" Noble' },
  { key: '36noble', label: '36" Noble' },
  { key: '48noble', label: '48" Noble' },
  { key: '60noble', label: '60" Noble' },
  { key: '72noble', label: '72" Noble' },
];

const GARLAND_LENGTHS: { key: GarlandLength; label: string }[] = [
  { key: '4.5ft', label: '4.5ft Noble' },
  { key: '9ft', label: '9ft Noble' },
];

export function HolidayRatesSettings() {
  const [rates, setRates] = useState<HolidayRates>(DEFAULT_HOLIDAY_RATES);
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
        if (data?.holidayRates) setRates(data.holidayRates as HolidayRates);
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

  function update(next: HolidayRates) {
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
        body: JSON.stringify({ holidayRates: rates }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Save failed (${res.status})`);
      }
      const data = await res.json();
      if (data?.holidayRates) setRates(data.holidayRates as HolidayRates);
      setStatus('saved');
      setDirty(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setStatus('error');
    }
  }

  if (status === 'loading') {
    return <p className="text-sm text-gray-500">Loading holiday rates…</p>;
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-gray-900">Holiday lighting rates</h2>
        <p className="mt-0.5 text-sm text-gray-500">
          Pricing for Christmas (holiday) quotes — separate from event, permanent, and bistro rates.
          Applies to <strong>new quotes only</strong>: every quote freezes these values when it&rsquo;s
          first calculated, and re-calculating an existing quote re-prices from its own frozen copy,
          never from this page. A blank or invalid value resets to the default on save.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Section title="Roofline ($/ft)">
          <RateField
            label="Easy"
            value={rates.rooflineRates.easy}
            onChange={(v) => update({ ...rates, rooflineRates: { ...rates.rooflineRates, easy: v } })}
            suffix="/ft"
          />
          <RateField
            label="Medium"
            value={rates.rooflineRates.medium}
            onChange={(v) => update({ ...rates, rooflineRates: { ...rates.rooflineRates, medium: v } })}
            suffix="/ft"
          />
          <RateField
            label="Hard"
            value={rates.rooflineRates.hard}
            onChange={(v) => update({ ...rates, rooflineRates: { ...rates.rooflineRates, hard: v } })}
            suffix="/ft"
          />
        </Section>

        <Section title="Stake lighting ($/ft)">
          <RateField
            label="Easy"
            value={rates.stakeLightingRates.easy}
            onChange={(v) => update({ ...rates, stakeLightingRates: { ...rates.stakeLightingRates, easy: v } })}
            suffix="/ft"
          />
          <RateField
            label="Medium"
            value={rates.stakeLightingRates.medium}
            onChange={(v) => update({ ...rates, stakeLightingRates: { ...rates.stakeLightingRates, medium: v } })}
            suffix="/ft"
          />
          <RateField
            label="Hard"
            value={rates.stakeLightingRates.hard}
            onChange={(v) => update({ ...rates, stakeLightingRates: { ...rates.stakeLightingRates, hard: v } })}
            suffix="/ft"
          />
        </Section>

        <Section title="Mini lights ($/string)">
          <RateField
            label="Canopy (bush / column / railing / curtain)"
            value={rates.miniLightRates.canopy}
            onChange={(v) => update({ ...rates, miniLightRates: { ...rates.miniLightRates, canopy: v } })}
            suffix="/string"
          />
          <RateField
            label="Trunk (large trees)"
            value={rates.miniLightRates.trunk}
            onChange={(v) => update({ ...rates, miniLightRates: { ...rates.miniLightRates, trunk: v } })}
            suffix="/string"
          />
        </Section>

        <Section title="Spritzers ($ each)">
          <RateField
            label='16"'
            value={rates.spritzerRates['16']}
            onChange={(v) => update({ ...rates, spritzerRates: { ...rates.spritzerRates, '16': v } })}
          />
          <RateField
            label='24"'
            value={rates.spritzerRates['24']}
            onChange={(v) => update({ ...rates, spritzerRates: { ...rates.spritzerRates, '24': v } })}
          />
          <RateField
            label='32"'
            value={rates.spritzerRates['32']}
            onChange={(v) => update({ ...rates, spritzerRates: { ...rates.spritzerRates, '32': v } })}
          />
        </Section>

        <Section title="Wreaths ($ each)">
          {WREATH_SIZES.map(({ key, label }) => (
            <div key={key} className="py-1.5">
              <div className="text-xs font-medium text-gray-500">{label}</div>
              <RateField
                label="Non-Decorated"
                value={rates.wreathPrices[key].bow}
                onChange={(v) =>
                  update({
                    ...rates,
                    wreathPrices: { ...rates.wreathPrices, [key]: { ...rates.wreathPrices[key], bow: v } },
                  })
                }
              />
              <RateField
                label="Decorated"
                value={rates.wreathPrices[key].fullDecor}
                onChange={(v) =>
                  update({
                    ...rates,
                    wreathPrices: { ...rates.wreathPrices, [key]: { ...rates.wreathPrices[key], fullDecor: v } },
                  })
                }
              />
            </div>
          ))}
        </Section>

        <Section title="Garland ($ each)">
          {GARLAND_LENGTHS.map(({ key, label }) => (
            <div key={key} className="py-1.5">
              <div className="text-xs font-medium text-gray-500">{label}</div>
              <RateField
                label="Non-Decorated"
                value={rates.garlandPrices.noble[key].bow}
                onChange={(v) =>
                  update({
                    ...rates,
                    garlandPrices: {
                      noble: { ...rates.garlandPrices.noble, [key]: { ...rates.garlandPrices.noble[key], bow: v } },
                    },
                  })
                }
              />
              <RateField
                label="Decorated"
                value={rates.garlandPrices.noble[key].fullDecor}
                onChange={(v) =>
                  update({
                    ...rates,
                    garlandPrices: {
                      noble: {
                        ...rates.garlandPrices.noble,
                        [key]: { ...rates.garlandPrices.noble[key], fullDecor: v },
                      },
                    },
                  })
                }
              />
            </div>
          ))}
          <RateField
            label="Standalone bow"
            value={rates.standaloneBowPrice}
            onChange={(v) => update({ ...rates, standaloneBowPrice: v })}
            suffix="each"
          />
        </Section>
      </div>

      {/* WT-63 follow-up: the global fee/tax/deposit/minimum/early-install fields
          are intentionally NOT editable here yet. The portal charge path still
          reads those six from the hardcoded engine defaults, so exposing them as
          editable would let a Settings edit silently diverge from what the
          customer is actually charged. They stay deploy-only until the portal
          charge path (derivePackages/SelectionContext/adapter) reads them from
          the frozen holidayRatesSnapshot. The per-item rates above DO flow end to
          end (they become frozen line items the portal sums). */}
      <p className="text-xs text-gray-400">
        Rush/takedown fees, tax rate, deposit percentage, the order minimum, and the
        early-install discounts are not adjustable here yet and stay at their current
        values. The per-item rates above apply to new quotes.
      </p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={status === 'saving' || !dirty}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : 'Save holiday rates'}
        </button>
        {status === 'saved' && <span className="text-sm text-emerald-600">Saved.</span>}
        {status === 'error' && error && <span className="text-sm text-red-600">{error}</span>}
      </div>
    </div>
  );
}
