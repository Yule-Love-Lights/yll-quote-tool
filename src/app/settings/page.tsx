'use client';

// Global app Settings page (task #32, Phase 1). Business-wide editor/render
// config, persisted via /api/settings. Phase 1 tabs: Palette (the editable bulb
// color list) + Rendering (global render tunables — spritzer ray density). Built
// to grow: Phase 2 adds per-type seed-default tabs, Phase 3 the custom library.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { BulbColor, ToolDefaults } from '@/lib/design/sceneTypes';
import type { AppSettings } from '@/lib/appSettings';
import { DEFAULT_COLORS, suggestGlow } from '@/components/design/editor-core/colors';
import {
  DEFAULT_RENDER_SETTINGS,
  type RenderSettings,
} from '@/components/design/editor-core/renderSettings';
import { DEFAULTS_TABS, mergeToolDefaults } from '@/lib/settings/toolDefaults';
import { DefaultsTabPanel } from '@/components/settings/DefaultsTabPanel';
import { CustomLibrary } from '@/components/settings/CustomLibrary';
import { invalidateAppSettings } from '@/lib/clientSettings';
import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';

type Status = 'idle' | 'saving' | 'saved' | 'error';

// Palette + the per-type defaults tabs (Lights/Decor/Text/Poles/Custom) + the
// global render tab.
const TABS: { id: string; label: string }[] = [
  { id: 'palette', label: 'Palette' },
  ...DEFAULTS_TABS.map((t) => ({ id: t.id, label: t.label })),
  { id: 'rendering', label: 'Rendering' },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<string>('palette');
  const [colors, setColors] = useState<BulbColor[]>(DEFAULT_COLORS);
  const [render, setRender] = useState<RenderSettings>(DEFAULT_RENDER_SETTINGS);
  const [defaults, setDefaults] = useState<ToolDefaults>(() => mergeToolDefaults(null));
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const s = (await res.json()) as AppSettings;
        if (cancelled) return;
        if (Array.isArray(s.colors) && s.colors.length > 0) setColors(s.colors);
        if (s.render) setRender(s.render);
        setDefaults(mergeToolDefaults(s.defaults));
      } catch {
        // Keep factory defaults on load failure; the user can still save.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (patch: Partial<Pick<AppSettings, 'colors' | 'render' | 'defaults'>>) => {
      setStatus('saving');
      setErrorMsg(null);
      try {
        const res = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        const s = (await res.json()) as AppSettings;
        if (Array.isArray(s.colors)) setColors(s.colors);
        if (s.render) setRender(s.render);
        setDefaults(mergeToolDefaults(s.defaults));
        // Editor + portal re-read settings on their next mount.
        invalidateAppSettings();
        setStatus('saved');
        window.setTimeout(() => setStatus('idle'), 1800);
      } catch (err) {
        setStatus('error');
        setErrorMsg(err instanceof Error ? err.message : 'Save failed');
      }
    },
    [],
  );

  return (
    <OperatorShell active="settings">
      <main className="max-w-3xl mx-auto">
      <SettingsSubNav active="settings" />

      <div className="flex items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Settings</h1>
          <p className="text-sm text-gray-500">Business-wide design + render configuration.</p>
        </div>
        <Link href="/admin/quotes" className="text-sm text-gray-500 hover:text-gray-800">
          ← Back to quotes
        </Link>
      </div>

      <div className="flex gap-1 border-b border-gray-200 mb-5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 ${
              tab === t.id
                ? 'border-green-600 text-green-700'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-gray-500 py-10 text-center">Loading settings…</p>
      ) : tab === 'palette' ? (
        <PaletteTab colors={colors} setColors={setColors} onSave={() => save({ colors })} />
      ) : tab === 'rendering' ? (
        <RenderingTab render={render} setRender={setRender} onSave={() => save({ render })} />
      ) : (
        <>
          <DefaultsTabPanel
            sectionKeys={DEFAULTS_TABS.find((t) => t.id === tab)?.sectionKeys ?? []}
            defaults={defaults}
            setDefaults={setDefaults}
            palette={colors}
            onSave={() => save({ defaults })}
          />
          {/* The Custom tab also manages the global graphic library (#32 Phase 3). */}
          {tab === 'custom' && <CustomLibrary />}
        </>
      )}

      {status !== 'idle' && (
        <p
          role="status"
          className={`mt-4 text-sm ${
            status === 'error' ? 'text-red-600' : status === 'saved' ? 'text-green-700' : 'text-gray-500'
          }`}
        >
          {status === 'saving' && 'Saving…'}
          {status === 'saved' && 'Saved.'}
          {status === 'error' && `Save failed: ${errorMsg}`}
        </p>
      )}
    </main>
    </OperatorShell>
  );
}

// ── Palette tab ─────────────────────────────────────────────────────────────

function PaletteTab({
  colors,
  setColors,
  onSave,
}: {
  colors: BulbColor[];
  setColors: React.Dispatch<React.SetStateAction<BulbColor[]>>;
  onSave: () => void;
}) {
  const update = (i: number, patch: Partial<BulbColor>) =>
    setColors((cs) => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  const remove = (i: number) => setColors((cs) => cs.filter((_, idx) => idx !== i));
  const add = () =>
    setColors((cs) => [
      ...cs,
      { id: crypto.randomUUID(), label: 'New color', hex: '#ffd27f', glow: suggestGlow('#ffd27f') },
    ]);

  return (
    <div>
      <p className="text-sm text-gray-600 mb-3">
        The bulb colors available in the design editor. Editing a color updates it everywhere it&apos;s
        used (editor + customer portal). Built-in colors can&apos;t be deleted (designs reference them),
        but you can recolor them.
      </p>
      <div className="space-y-2">
        {colors.map((c, i) => (
          <div key={c.id} className="flex items-center gap-3 border border-gray-200 rounded-md p-2">
            <span
              aria-hidden
              className="w-7 h-7 rounded-full ring-1 ring-black/10 shrink-0"
              style={{ background: c.hex, boxShadow: `0 0 8px ${c.glow}` }}
            />
            <input
              type="text"
              value={c.label}
              onChange={(e) => update(i, { label: e.target.value })}
              className="flex-1 border border-gray-300 rounded px-2 py-1 text-sm"
              aria-label="Color name"
            />
            <label className="flex items-center gap-1 text-xs text-gray-500">
              Color
              <input
                type="color"
                value={c.hex}
                onChange={(e) => update(i, { hex: e.target.value, glow: suggestGlow(e.target.value) })}
                className="w-8 h-8 rounded border border-gray-300 bg-white p-0.5"
                aria-label="Bulb color"
              />
            </label>
            <label className="flex items-center gap-1 text-xs text-gray-500">
              Glow
              <input
                type="color"
                value={c.glow}
                onChange={(e) => update(i, { glow: e.target.value })}
                className="w-8 h-8 rounded border border-gray-300 bg-white p-0.5"
                aria-label="Glow color"
              />
            </label>
            {c.builtin ? (
              <span className="text-[10px] uppercase tracking-wide text-gray-400 w-16 text-center">Built-in</span>
            ) : (
              <button
                type="button"
                onClick={() => remove(i)}
                className="text-red-400 hover:text-red-600 text-sm w-16"
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 mt-4">
        <button
          type="button"
          onClick={add}
          className="text-sm text-green-700 hover:text-green-900 font-medium border border-green-300 hover:border-green-500 rounded-md px-3 py-1.5"
        >
          + Add color
        </button>
        <button
          type="button"
          onClick={() => setColors(DEFAULT_COLORS)}
          className="text-sm text-gray-500 hover:text-gray-800 border border-gray-300 rounded-md px-3 py-1.5"
        >
          Reset to defaults
        </button>
        <button
          type="button"
          onClick={onSave}
          className="ml-auto text-sm font-semibold text-white bg-green-600 hover:bg-green-700 rounded-md px-4 py-1.5"
        >
          Save palette
        </button>
      </div>
    </div>
  );
}

// ── Rendering tab ───────────────────────────────────────────────────────────

function RenderingTab({
  render,
  setRender,
  onSave,
}: {
  render: RenderSettings;
  setRender: React.Dispatch<React.SetStateAction<RenderSettings>>;
  onSave: () => void;
}) {
  return (
    <div>
      <p className="text-sm text-gray-600 mb-4">
        Global appearance tuning applied to every design — in the editor and on the customer portal,
        including existing designs.
      </p>

      <div className="border border-gray-200 rounded-md p-4">
        <div className="flex items-center justify-between mb-1">
          <label htmlFor="spritzer-density" className="text-sm font-medium text-gray-800">
            Spritzer ray density
          </label>
          <span className="text-sm tabular-nums text-gray-600">{render.spritzerRayDensity.toFixed(2)}</span>
        </div>
        <input
          id="spritzer-density"
          type="range"
          min={0.1}
          max={1.5}
          step={0.05}
          value={render.spritzerRayDensity}
          onChange={(e) => setRender((r) => ({ ...r, spritzerRayDensity: Number(e.target.value) }))}
          className="w-full"
        />
        <p className="text-[11px] text-gray-400 mt-1">
          Rays per pixel of a spritzer&apos;s rendered radius (clamped 7–36 rays). Default 0.45 ≈ ~22 rays
          on a 24″ spritzer. Higher = denser spray.
        </p>
      </div>

      <div className="flex items-center gap-2 mt-4">
        <button
          type="button"
          onClick={() => setRender(DEFAULT_RENDER_SETTINGS)}
          className="text-sm text-gray-500 hover:text-gray-800 border border-gray-300 rounded-md px-3 py-1.5"
        >
          Reset to defaults
        </button>
        <button
          type="button"
          onClick={onSave}
          className="ml-auto text-sm font-semibold text-white bg-green-600 hover:bg-green-700 rounded-md px-4 py-1.5"
        >
          Save rendering
        </button>
      </div>
    </div>
  );
}
