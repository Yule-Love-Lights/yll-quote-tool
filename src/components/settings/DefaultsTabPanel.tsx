'use client';

// Renders one /settings "defaults" tab (#32 Phase 2): the per-type sections for
// the tab, each a card of data-driven fields seeded from the merged defaults.
// Editing updates the shared `defaults` state; Save persists the whole object.

import type { Dispatch, SetStateAction } from 'react';
import type { BulbColor, ToolDefaults } from '@/lib/design/sceneTypes';
import { DEFAULT_TOOL_DEFAULTS, sectionByKey } from '@/lib/settings/toolDefaults';
import { SettingsField } from './SettingsField';

export function DefaultsTabPanel({
  sectionKeys,
  defaults,
  setDefaults,
  palette,
  onSave,
}: {
  sectionKeys: string[];
  defaults: ToolDefaults;
  setDefaults: Dispatch<SetStateAction<ToolDefaults>>;
  palette: BulbColor[];
  onSave: () => void;
}) {
  const update = (type: string, key: string, val: unknown) =>
    setDefaults((d) => ({ ...d, [type]: { ...(d[type] ?? {}), [key]: val } }));
  const resetType = (type: string) =>
    setDefaults((d) => ({ ...d, [type]: { ...DEFAULT_TOOL_DEFAULTS[type] } }));

  return (
    <div>
      <p className="text-sm text-gray-600 mb-3">
        Defaults applied to <strong>new</strong>{' '}items placed in the design editor. Existing
        items aren&apos;t changed.
      </p>
      <div className="space-y-4">
        {sectionKeys.map((key) => {
          const section = sectionByKey(key);
          if (!section) return null;
          const entry = defaults[key] ?? {};
          return (
            <div key={key} className="border border-gray-200 rounded-md p-3">
              <div className="flex items-center justify-between mb-1">
                <h3 className="text-sm font-semibold text-gray-800">{section.label}</h3>
                <button
                  type="button"
                  onClick={() => resetType(key)}
                  className="text-[11px] text-gray-400 hover:text-gray-700"
                >
                  Reset
                </button>
              </div>
              <div className="divide-y divide-gray-100">
                {section.fields.map((f) => (
                  <SettingsField
                    key={f.key}
                    spec={f}
                    value={entry[f.key]}
                    onChange={(v) => update(key, f.key, v)}
                    palette={palette}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex mt-4">
        <button
          type="button"
          onClick={onSave}
          className="ml-auto text-sm font-semibold text-white bg-green-600 hover:bg-green-700 rounded-md px-4 py-1.5"
        >
          Save defaults
        </button>
      </div>
    </div>
  );
}
