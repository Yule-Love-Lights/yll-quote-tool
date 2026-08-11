'use client';

// Data-driven control for one per-type default field (#32 Phase 2). Renders a
// labelled row whose input is chosen by the FieldSpec `kind`. Color resolution
// uses the passed `palette` (the live edited list) rather than the editor-core
// global, since the Settings page doesn't push the palette into that global.

import type { FieldSpec } from '@/lib/settings/toolDefaults';
import type { BulbColor } from '@/lib/design/sceneTypes';

const selCls = 'border border-gray-300 rounded px-2 py-1 text-sm bg-white';

// The <option> values to render for a 'spacing' select: the preset list, plus
// -- only when `value` isn't one of them -- a trailing entry for the actual
// stored value. #223: trimming a type's presets (e.g. wreath 4→3, #202) can
// leave an already-saved staff default (an old design's dropped tier) outside
// the new option list. A plain <select value={value}> with no matching
// <option> renders blank/unselected, which both hides what's actually stored
// AND risks the field looking "empty" to staff who never touch it -- so keep
// the real value selectable and visibly marked instead of letting it vanish
// from the control. The stored default itself is untouched either way: this
// only changes what's rendered, not `value`, so an unrelated Save on the same
// page still round-trips the legacy number exactly as stored. Mirrors
// editor.ts's sizeButtons() 4th "you are here" button for the same #202 case.
export function spacingSelectOptions(options: readonly number[], value: number): number[] {
  return options.includes(value) ? [...options] : [...options, value];
}

export function SettingsField({
  spec,
  value,
  onChange,
  palette,
}: {
  spec: FieldSpec;
  value: unknown;
  onChange: (v: unknown) => void;
  palette: BulbColor[];
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <label className="text-sm text-gray-700">{spec.label}</label>
      <div className="flex items-center gap-2">{renderControl(spec, value, onChange, palette)}</div>
    </div>
  );
}

function renderControl(
  spec: FieldSpec,
  value: unknown,
  onChange: (v: unknown) => void,
  palette: BulbColor[],
) {
  switch (spec.kind) {
    case 'spacing': {
      const v = typeof value === 'number' ? value : spec.options[0];
      const opts = spacingSelectOptions(spec.options, v);
      return (
        <select className={selCls} value={v} onChange={(e) => onChange(Number(e.target.value))}>
          {opts.map((o) => (
            <option key={o} value={o}>
              {o}
              {spec.unit ?? ''}
              {!spec.options.includes(o) ? ' (current)' : ''}
            </option>
          ))}
        </select>
      );
    }
    case 'style':
    case 'font': {
      const v = typeof value === 'string' ? value : spec.options[0];
      return (
        <select className={selCls} value={v} onChange={(e) => onChange(e.target.value)}>
          {spec.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    }
    case 'number': {
      const v = typeof value === 'number' ? value : spec.min;
      return (
        <>
          <input
            type="range"
            min={spec.min}
            max={spec.max}
            step={spec.step}
            value={v}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-40"
          />
          <span className="text-sm tabular-nums text-gray-600 w-14 text-right">
            {v}
            {spec.unit ?? ''}
          </span>
        </>
      );
    }
    case 'bool': {
      const v = value === true;
      return (
        <input
          type="checkbox"
          checked={v}
          onChange={(e) => onChange(e.target.checked)}
          className="w-4 h-4"
        />
      );
    }
    case 'color-pattern':
      return (
        <ColorPatternEditor
          value={Array.isArray(value) ? (value as string[]) : []}
          onChange={onChange}
          palette={palette}
        />
      );
  }
}

function ColorPatternEditor({
  value,
  onChange,
  palette,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  palette: BulbColor[];
}) {
  const byId = new Map(palette.map((c) => [c.id, c]));
  const hexOf = (id: string) => byId.get(id)?.hex ?? '#cccccc';

  return (
    <div className="flex flex-col items-end gap-1.5">
      {/* Current sequence — click a swatch to remove it. */}
      <div className="flex items-center gap-1 flex-wrap justify-end max-w-[220px]">
        {value.length === 0 ? (
          <span className="text-[11px] text-gray-400">(defaults to warm white)</span>
        ) : (
          value.map((id, i) => (
            <button
              key={`${id}-${i}`}
              type="button"
              title={`${byId.get(id)?.label ?? id} — click to remove`}
              onClick={() => onChange(value.filter((_, idx) => idx !== i))}
              className="w-5 h-5 rounded-full ring-1 ring-black/15 hover:ring-red-400"
              style={{ background: hexOf(id) }}
            />
          ))
        )}
        {value.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="text-[11px] text-gray-400 hover:text-gray-700 ml-1"
          >
            clear
          </button>
        )}
      </div>
      {/* Palette — click to append to the sequence. */}
      <div className="flex items-center gap-1 flex-wrap justify-end max-w-[220px]">
        {palette.map((c) => (
          <button
            key={c.id}
            type="button"
            title={`Add ${c.label}`}
            onClick={() => onChange([...value, c.id])}
            className="w-4 h-4 rounded-full ring-1 ring-black/10 hover:scale-125 transition-transform"
            style={{ background: c.hex }}
          />
        ))}
      </div>
    </div>
  );
}
