'use client';

import type { QuoteFormData } from '@/lib/quoteForm';
import type { PermanentQuoteFields, PermanentGap } from '@/lib/permanent/types';

const lbl = 'block text-xs font-medium text-gray-500 uppercase tracking-wide mb-1';
const inp = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500';
const sel = 'w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500';

// Which house side each footage/corner field belongs to — editing one marks that
// side 'manual' (a hand-typed override of the satellite-measured number).
const SIDE_OF_FIELD: Partial<Record<keyof PermanentQuoteFields, 'front' | 'left' | 'right' | 'back'>> = {
  frontFootage: 'front',
  frontCorners: 'front',
  leftFootage: 'left',
  leftCorners: 'left',
  rightFootage: 'right',
  rightCorners: 'right',
  backFootage: 'back',
  backCorners: 'back',
};

// Mirrors the holiday builder's Section card (QuoteBuilder.tsx) so the permanent
// sections read as the same surface — white card, uppercase header, divider.
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 mb-4">
      <h3 className="text-sm font-semibold text-gray-800 uppercase tracking-wide mb-4 pb-2 border-b border-gray-100">
        {title}
      </h3>
      {children}
    </div>
  );
}

type PermanentSectionProps = {
  form: QuoteFormData;
  setForm: React.Dispatch<React.SetStateAction<QuoteFormData>>;
};

// Footage + corners come from the satellite-view roofline draw (#88 / S23, per
// Jason — the design projection was dropped as inaccurate). The operator draws
// each side on the Satellite tab; those measurements flow into the fields below,
// which stay hand-editable.
export default function PermanentSection({ form, setForm }: PermanentSectionProps) {
  const p = form.permanent;

  const setP = <K extends keyof PermanentQuoteFields>(k: K, v: PermanentQuoteFields[K]) =>
    setForm((f) => {
      const side = SIDE_OF_FIELD[k];
      const permanent = { ...f.permanent, [k]: v };
      if (side) permanent.sideSource = { ...(f.permanent.sideSource ?? {}), [side]: 'manual' };
      return { ...f, permanent };
    });

  const patchGap = (idx: number, patch: Partial<PermanentGap>) =>
    setForm((f) => {
      const gaps = f.permanent.gaps.map((g, i) =>
        i === idx ? { ...g, ...patch, source: (g.source === 'manual' ? 'manual' : 'edited') as PermanentGap['source'] } : g
      );
      return { ...f, permanent: { ...f.permanent, gaps } };
    });

  const removeGap = (idx: number) =>
    setForm((f) => ({ ...f, permanent: { ...f.permanent, gaps: f.permanent.gaps.filter((_, i) => i !== idx) } }));

  const addGap = () =>
    setForm((f) => ({
      ...f,
      permanent: { ...f.permanent, gaps: [...f.permanent.gaps, { lengthFt: 0, source: 'manual' as const }] },
    }));

  return (
    <div>
      <Section title="Front of Home">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={lbl}>Front footage</label>
            <input
              type="number"
              min={0}
              className={inp}
              value={p.frontFootage}
              onChange={(e) => setP('frontFootage', Number(e.target.value))}
            />
            {p.frontFootage === 0 && (
              <p className="text-xs text-amber-600 mt-1">
                Front footage is 0 — draw the front roofline on the Satellite tab, or enter it manually.
              </p>
            )}
          </div>
          <div>
            <label className={lbl}>Front corners</label>
            <input
              type="number"
              min={0}
              className={inp}
              value={p.frontCorners}
              onChange={(e) => setP('frontCorners', Number(e.target.value))}
            />
            <p className="text-xs text-gray-400 mt-1">
              Every corner / end / gable peak = 3 lights. Auto-counted from the satellite draw; adjust if needed.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Sides &amp; Back">
        <p className="text-xs text-gray-400 mb-3">
          Drawn on the Satellite tab (footage &amp; corners fill in per side), or enter manually. A hand-typed
          number overrides the drawn measurement. Left and Right each bill as their own line item.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={lbl}>Left footage</label>
            <input
              type="number"
              min={0}
              className={inp}
              value={p.leftFootage}
              onChange={(e) => setP('leftFootage', Number(e.target.value))}
            />
          </div>
          <div>
            <label className={lbl}>Left corners</label>
            <input
              type="number"
              min={0}
              className={inp}
              value={p.leftCorners}
              onChange={(e) => setP('leftCorners', Number(e.target.value))}
            />
          </div>
          <div>
            <label className={lbl}>Right footage</label>
            <input
              type="number"
              min={0}
              className={inp}
              value={p.rightFootage}
              onChange={(e) => setP('rightFootage', Number(e.target.value))}
            />
          </div>
          <div>
            <label className={lbl}>Right corners</label>
            <input
              type="number"
              min={0}
              className={inp}
              value={p.rightCorners}
              onChange={(e) => setP('rightCorners', Number(e.target.value))}
            />
          </div>
          <div>
            <label className={lbl}>Back footage</label>
            <input
              type="number"
              min={0}
              className={inp}
              value={p.backFootage}
              onChange={(e) => setP('backFootage', Number(e.target.value))}
            />
          </div>
          <div>
            <label className={lbl}>Back corners</label>
            <input
              type="number"
              min={0}
              className={inp}
              value={p.backCorners}
              onChange={(e) => setP('backCorners', Number(e.target.value))}
            />
          </div>
        </div>
      </Section>

      <Section title="System details">
        <div>
          <label className={lbl}>Controller → first light (ft)</label>
          <input
            type="number"
            min={0}
            className={`${inp} sm:w-1/2`}
            value={p.controllerToFirstLightFt}
            onChange={(e) => setP('controllerToFirstLightFt', Number(e.target.value))}
          />
          <p className="text-xs text-gray-400 mt-1">
            Controller → first light. Over 10 ft adds a signal booster (materials only).
          </p>
        </div>

        <div className="mt-4">
          <p className="text-xs text-gray-400 mb-2">
            Jumps between runs (controller→run, run→run, house→garage). Affects the materials/BOM
            only — not the price.
          </p>
          <div className="space-y-2">
            {p.gaps.map((g, idx) => (
              <div key={idx} className="flex flex-wrap items-center gap-3 border border-gray-100 rounded-md p-2">
                <div className="w-28">
                  <label className={lbl}>Length (ft)</label>
                  <input
                    type="number"
                    min={0}
                    className={inp}
                    value={g.lengthFt}
                    onChange={(e) => patchGap(idx, { lengthFt: Number(e.target.value) })}
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="checkbox"
                    checked={!!g.splitter}
                    onChange={(e) => patchGap(idx, { splitter: e.target.checked })}
                  />
                  Branches here (splitter)
                </label>
                {(g.source === 'auto' || g.source === 'edited') && g.detectedFt !== undefined && (
                  <span className="text-xs text-gray-400">auto-detected: {g.detectedFt} ft</span>
                )}
                <button
                  type="button"
                  onClick={() => removeGap(idx)}
                  className="text-xs text-red-600 hover:text-red-800 ml-auto"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addGap}
            className="mt-2 text-sm px-3 py-1.5 rounded-md border border-gray-300 bg-white hover:bg-gray-50"
          >
            Add gap
          </button>
        </div>
      </Section>

      <Section title="Track &amp; options">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={lbl}>Track style</label>
            <select
              className={sel}
              value={p.trackStyle}
              onChange={(e) => setP('trackStyle', e.target.value as PermanentQuoteFields['trackStyle'])}
            >
              <option value="single">Single (soffit)</option>
              <option value="parapet">Parapet (fascia)</option>
            </select>
          </div>
          <div>
            <label className={lbl}>Track color</label>
            <select
              className={sel}
              value={p.trackColor}
              onChange={(e) => setP('trackColor', e.target.value as PermanentQuoteFields['trackColor'])}
            >
              <option value="9003">White (9003)</option>
              <option value="9004">Black (9004)</option>
              <option value="9012">Cream (9012)</option>
              <option value="8019">Dark brown (8019)</option>
            </select>
          </div>
        </div>
        <div className="mt-4 space-y-2">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={p.blackHousing}
              onChange={(e) => setP('blackHousing', e.target.checked)}
            />
            Black puck housing (-BLK)
          </label>
          <div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                checked={p.maintenanceAddOn}
                onChange={(e) => setP('maintenanceAddOn', e.target.checked)}
              />
              Annual maintenance add-on
            </label>
            <p className="text-xs text-gray-400 mt-1 ml-6">
              Priced in Settings; no charge if unset.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Custom pricing (optional)">
        <p className="text-xs text-gray-400 mb-3">
          Overrides the standard rate for this group. Leave off to use the Settings rate.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="flex items-center gap-2 text-sm text-gray-700 mb-1">
              <input
                type="checkbox"
                checked={p.frontCustomRate !== undefined}
                onChange={(e) => setP('frontCustomRate', e.target.checked ? 0 : undefined)}
              />
              Custom $/ft — Front
            </label>
            {p.frontCustomRate !== undefined && (
              <input
                type="number"
                min={0}
                className={inp}
                value={p.frontCustomRate ?? ''}
                onChange={(e) => setP('frontCustomRate', Number(e.target.value))}
              />
            )}
          </div>
          <div>
            <label className="flex items-center gap-2 text-sm text-gray-700 mb-1">
              <input
                type="checkbox"
                checked={p.sidesCustomRate !== undefined}
                onChange={(e) => setP('sidesCustomRate', e.target.checked ? 0 : undefined)}
              />
              Custom $/ft — Sides
            </label>
            {p.sidesCustomRate !== undefined && (
              <input
                type="number"
                min={0}
                className={inp}
                value={p.sidesCustomRate ?? ''}
                onChange={(e) => setP('sidesCustomRate', Number(e.target.value))}
              />
            )}
          </div>
          <div>
            <label className="flex items-center gap-2 text-sm text-gray-700 mb-1">
              <input
                type="checkbox"
                checked={p.backCustomRate !== undefined}
                onChange={(e) => setP('backCustomRate', e.target.checked ? 0 : undefined)}
              />
              Custom $/ft — Back
            </label>
            {p.backCustomRate !== undefined && (
              <input
                type="number"
                min={0}
                className={inp}
                value={p.backCustomRate ?? ''}
                onChange={(e) => setP('backCustomRate', Number(e.target.value))}
              />
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}
