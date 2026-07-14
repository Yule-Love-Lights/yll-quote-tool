'use client';

import type { QuoteFormData } from '@/lib/quoteForm';
import { roundFootageUpTo5, type PermanentQuoteFields } from '@/lib/permanent/types';

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
  // #142: fired when the operator clicks "Recount from drawn lines" — the
  // builder thaws its rehydrate freeze so the recount actually derives.
  onRecount?: () => void;
  // PS-B1: which sides currently have a drawn/hydrated satellite trace, so a
  // billed side with no trace (never shows on the portal's roof map) can be
  // flagged inline. Omit or leave tracedReady false to suppress the warning
  // (e.g. before the builder knows whether a reopened quote's trace has
  // finished loading — see QuoteBuilder's permTraceHydrated).
  tracedSides?: { front: boolean; left: boolean; right: boolean; back: boolean };
  tracedReady?: boolean;
};

const SIDE_LABEL: Record<'front' | 'left' | 'right' | 'back', string> = {
  front: 'Front',
  left: 'Left side',
  right: 'Right side',
  back: 'Back',
};

// Footage + corners come from the satellite-view roofline draw (#88 / S23, per
// Jason — the design projection was dropped as inaccurate). The operator draws
// each side on the Satellite tab; those measurements flow into the fields below,
// which stay hand-editable.
export default function PermanentSection({ form, setForm, onRecount, tracedSides, tracedReady }: PermanentSectionProps) {
  const p = form.permanent;

  // PS-B1: this side bills (footage > 0) but has no drawn satellite trace, so
  // the portal's roof map won't show it — a visible mismatch between what the
  // customer is billed for and what they see. Only fires once tracedReady
  // (avoids a false flash on a reopened quote before its trace has loaded).
  const untracedButBilled = (side: 'front' | 'left' | 'right' | 'back', footage: number) =>
    tracedReady === true && footage > 0 && tracedSides?.[side] === false;

  const setP = <K extends keyof PermanentQuoteFields>(k: K, v: PermanentQuoteFields[K]) =>
    setForm((f) => {
      const side = SIDE_OF_FIELD[k];
      const permanent = { ...f.permanent, [k]: v };
      if (side) permanent.sideSource = { ...(f.permanent.sideSource ?? {}), [side]: 'manual' };
      return { ...f, permanent };
    });

  // #139 (Jason S24): footage bills in 5-ft steps — a hand-typed value rounds
  // UP to the next multiple of 5 when the operator leaves the field (22 → 25;
  // exact multiples stay put). On-blur, not per keystroke, so typing "22" isn't
  // fought mid-entry. No-ops when already rounded, so merely focusing a
  // satellite-measured field never flips its sideSource to 'manual'.
  const roundFootageOnBlur =
    (k: 'frontFootage' | 'leftFootage' | 'rightFootage' | 'backFootage') => () => {
      const r = roundFootageUpTo5(p[k]);
      if (r !== p[k]) setP(k, r);
    };

  // #140 Extensions/Splitters card: typing any count takes MANUAL ownership —
  // the geometry/AI derive stops writing until "Recount" hands it back.
  const setAccessoryCount = (
    patch: Partial<{ e3: number; e5: number; e10: number; e25: number }> | null,
    scalar?: { key: 'splittersNeeded' | 'jumpBoosters'; value: number },
  ) =>
    setForm((f) => {
      const cur = f.permanent;
      const extensions = { e3: 0, e5: 0, e10: 0, e25: 0, ...(cur.extensions ?? {}), ...(patch ?? {}) };
      return {
        ...f,
        permanent: {
          ...cur,
          extensions,
          ...(scalar ? { [scalar.key]: scalar.value } : {}),
          accessoriesSource: 'manual',
        },
      };
    });

  const recountAccessories = () => {
    onRecount?.();
    setForm((f) => ({ ...f, permanent: { ...f.permanent, accessoriesSource: 'auto' } }));
  };

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
              onBlur={roundFootageOnBlur('frontFootage')}
            />
            {p.frontFootage === 0 && (
              <p className="text-xs text-amber-600 mt-1">
                Front footage is 0 — draw the front roofline on the Satellite tab, or enter it manually.
              </p>
            )}
            {untracedButBilled('front', p.frontFootage) && (
              <p className="text-xs text-amber-600 mt-1">
                {SIDE_LABEL.front} is billed but has no drawn line on the Satellite tab, so the portal&apos;s
                roof map won&apos;t show it. Draw it there, or confirm this is correct before sending.
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
              onBlur={roundFootageOnBlur('leftFootage')}
            />
            {untracedButBilled('left', p.leftFootage) && (
              <p className="text-xs text-amber-600 mt-1">
                {SIDE_LABEL.left} is billed but has no drawn line on the Satellite tab, so the portal&apos;s
                roof map won&apos;t show it. Draw it there, or confirm this is correct before sending.
              </p>
            )}
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
              onBlur={roundFootageOnBlur('rightFootage')}
            />
            {untracedButBilled('right', p.rightFootage) && (
              <p className="text-xs text-amber-600 mt-1">
                {SIDE_LABEL.right} is billed but has no drawn line on the Satellite tab, so the portal&apos;s
                roof map won&apos;t show it. Draw it there, or confirm this is correct before sending.
              </p>
            )}
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
              onBlur={roundFootageOnBlur('backFootage')}
            />
            {untracedButBilled('back', p.backFootage) && (
              <p className="text-xs text-amber-600 mt-1">
                {SIDE_LABEL.back} is billed but has no drawn line on the Satellite tab, so the portal&apos;s
                roof map won&apos;t show it. Draw it there, or confirm this is correct before sending.
              </p>
            )}
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

      <Section title="Extensions / Splitters">
        <p className="text-xs text-gray-400 mb-3">
          Track accessories for the material order — never the customer price. Counted
          automatically from the drawn lines (every corner/peak cut = one 5&apos;; measured jumps
          size up generously). Type over any count to take it manual.
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          {(
            [
              ['e3', "3' Extension"],
              ['e5', "5' Extension"],
              ['e10', "10' Extension"],
              ['e25', "25' Extension"],
            ] as const
          ).map(([key, label]) => (
            <div key={key}>
              <label className={lbl}>{label}</label>
              <input
                type="number"
                min={0}
                className={inp}
                value={p.extensions?.[key] ?? 0}
                onChange={(e) => setAccessoryCount({ [key]: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
              />
            </div>
          ))}
          <div>
            <label className={lbl}>Splitters needed</label>
            <input
              type="number"
              min={0}
              className={inp}
              value={p.splittersNeeded ?? 0}
              onChange={(e) =>
                setAccessoryCount(null, { key: 'splittersNeeded', value: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
              }
            />
            <p className="text-xs text-gray-400 mt-1">Where the line branches to a second level/direction.</p>
          </div>
          <div>
            <label className={lbl}>Extra signal boosters</label>
            <input
              type="number"
              min={0}
              className={inp}
              value={p.jumpBoosters ?? 0}
              onChange={(e) =>
                setAccessoryCount(null, { key: 'jumpBoosters', value: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
              }
            />
            <p className="text-xs text-gray-400 mt-1">One per jump over {'>'}50 ft (the controller rule is separate).</p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          {p.accessoriesSource === 'manual' ? (
            <>
              <span className="text-xs font-medium text-amber-600">Manually set — auto-count paused.</span>
              <button
                type="button"
                onClick={recountAccessories}
                className="text-sm px-3 py-1.5 rounded-md border border-gray-300 bg-white hover:bg-gray-50"
              >
                Recount from drawn lines
              </button>
            </>
          ) : (
            <span className="text-xs text-gray-400">
              {p.accessoriesSource === 'auto'
                ? 'Auto-counted from the drawn lines.'
                : 'Counts appear when lines are drawn (satellite or design).'}
            </span>
          )}
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
