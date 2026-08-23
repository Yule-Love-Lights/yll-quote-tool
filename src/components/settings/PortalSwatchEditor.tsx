'use client';

// Settings → Customer Portal — light-color swatch editor (#101). Curates the
// customer-facing swatch presets + the build-your-own palette, data-driven from
// app_settings (the `swatches` key). Curate from the EXISTING built-in palette
// only (no new hex): rename / reorder / remove / add presets composed from
// palette colors, and toggle which colors the build-your-own picker offers.
//
// "As designed" (the safe default the portal opens on) is pinned first and can be
// renamed but never reordered or removed. Scheme IDs are STABLE — the composer
// assigns one at add-time from the label and never changes it on rename, so a
// quote saved with a scheme id keeps resolving.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ColorScheme } from '@/lib/design/colorSchemes';
import { DEFAULT_COLOR_SCHEME_ID } from '@/lib/design/colorSchemes';
import type { BulbColor } from '@/lib/design/sceneTypes';

type Status = 'loading' | 'idle' | 'saving' | 'saved' | 'error';

// Swatch preview background from a scheme's color ids (mirrors the portal picker):
// null/empty → neutral two-tone "as designed" chip; one color → solid; many →
// even-segment diagonal gradient so the pattern reads.
function swatchStyle(colorIds: string[] | null, hexOf: (id: string) => string): React.CSSProperties {
  if (!colorIds || colorIds.length === 0) {
    return { background: 'linear-gradient(135deg, #c9c2b0 0 50%, #6f6a5c 50% 100%)' };
  }
  const hexes = colorIds.map(hexOf);
  if (hexes.length === 1) return { background: hexes[0] };
  const stops = hexes
    .map((h, i) => `${h} ${(i / hexes.length) * 100}% ${((i + 1) / hexes.length) * 100}%`)
    .join(', ');
  return { background: `linear-gradient(135deg, ${stops})` };
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'swatch'
  );
}

// #88 P6b-4 — the same editor drives BOTH the holiday `swatches` and the permanent
// `permanentSwatches` app_settings keys; the caller picks which via `settingsKey`.
type PortalSwatchEditorProps = {
  settingsKey?: 'swatches' | 'permanentSwatches';
  title?: string;
  description?: string;
};

export function PortalSwatchEditor({
  settingsKey = 'swatches',
  title = 'Light color swatches',
  description = 'The color presets a customer picks from on the portal. Rename, reorder, remove, or add your own — built from your existing bulb colors. “Staff’s pick” (as designed) always stays first.',
}: PortalSwatchEditorProps = {}) {
  const [schemes, setSchemes] = useState<ColorScheme[]>([]);
  const [buildable, setBuildable] = useState<string[]>([]);
  const [palette, setPalette] = useState<BulbColor[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // "Add a swatch" composer.
  const [newLabel, setNewLabel] = useState('');
  const [newColors, setNewColors] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) throw new Error('load failed');
        const data = await res.json();
        if (!alive) return;
        setSchemes(data?.[settingsKey]?.schemes ?? []);
        setBuildable(data?.[settingsKey]?.buildableColorIds ?? []);
        setPalette(Array.isArray(data?.colors) ? data.colors : []);
        setStatus('idle');
      } catch {
        if (alive) {
          setError('Could not load swatches');
          setStatus('error');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [settingsKey]);

  const colorMap = useMemo(() => new Map(palette.map((c) => [c.id, c])), [palette]);
  const hexOf = useCallback((id: string) => colorMap.get(id)?.hex ?? '#888888', [colorMap]);
  const labelOf = useCallback((id: string) => colorMap.get(id)?.label ?? id, [colorMap]);
  // Colors offer-able in build-your-own + the composer: every palette color but black.
  const paletteChips = useMemo(() => palette.filter((c) => c.id !== 'black'), [palette]);

  const buildableSet = useMemo(() => new Set(buildable), [buildable]);
  const mark = () => setDirty(true);

  // ── Scheme ops ──────────────────────────────────────────────────────────
  const renameScheme = (id: string, label: string) => {
    setSchemes((ss) => ss.map((s) => (s.id === id ? { ...s, label } : s)));
    mark();
  };
  const removeScheme = (id: string) => {
    if (id === DEFAULT_COLOR_SCHEME_ID) return; // as-designed is pinned
    setSchemes((ss) => ss.filter((s) => s.id !== id));
    mark();
  };
  const moveScheme = (id: string, dir: -1 | 1) => {
    setSchemes((ss) => {
      const i = ss.findIndex((s) => s.id === id);
      const j = i + dir;
      // Never move as-designed (index 0), and nothing may move above it.
      if (i <= 0 || j <= 0 || j >= ss.length) return ss;
      const next = [...ss];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    mark();
  };
  const addScheme = () => {
    const label = newLabel.trim();
    if (!label || newColors.length === 0) return;
    // Stable, unique id from the label (kept even if the label is later renamed).
    const base = slugify(label);
    const taken = new Set<string>([...schemes.map((s) => s.id), 'custom']);
    let id = base;
    let n = 2;
    while (taken.has(id)) id = `${base}-${n++}`;
    setSchemes((ss) => [...ss, { id, label, colorIds: newColors }]);
    setNewLabel('');
    setNewColors([]);
    mark();
  };

  // ── Build-your-own palette ──────────────────────────────────────────────
  const toggleBuildable = (id: string) => {
    setBuildable((b) => (b.includes(id) ? b.filter((x) => x !== id) : [...b, id]));
    mark();
  };

  const save = async () => {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [settingsKey]: { schemes, buildableColorIds: buildable } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Save failed');
      }
      // Re-read the normalized result (as-designed pinned first, ids cleaned).
      const data = await res.json();
      setSchemes(data?.[settingsKey]?.schemes ?? schemes);
      setBuildable(data?.[settingsKey]?.buildableColorIds ?? buildable);
      setDirty(false);
      setStatus('saved');
      window.setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setStatus('error');
    }
  };

  const busy = status === 'loading' || status === 'saving';

  return (
    <div className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6 mt-6">
      <h2 className="text-[15px] font-medium text-gray-900">{title}</h2>
      <p className="text-sm text-gray-500 mt-1 leading-relaxed">{description}</p>

      {/* row 332, mirrors #171b: was a bare "Loading…" line gating the whole
          scheme list below — replaced with placeholder rows matching that
          list's own shape so there's no morph from empty text into rows. */}
      {status === 'loading' && (
        <div role="status" aria-busy="true" className="mt-4 space-y-2.5">
          <div className="h-10 animate-pulse rounded-md bg-black/10" />
          <div className="h-10 animate-pulse rounded-md bg-black/10" />
          <div className="h-10 animate-pulse rounded-md bg-black/10" />
        </div>
      )}

      {status !== 'loading' && (
        <>
          {/* Scheme list */}
          <ul className="mt-4 divide-y divide-gray-100">
            {schemes.map((s, i) => {
              const pinned = s.id === DEFAULT_COLOR_SCHEME_ID;
              return (
                <li key={s.id} className="flex items-center gap-3 py-2.5">
                  <span
                    aria-hidden
                    className="w-6 h-6 rounded-full ring-1 ring-black/10 shrink-0"
                    style={swatchStyle(s.colorIds, hexOf)}
                  />
                  <input
                    aria-label={`Swatch label for ${s.id}`}
                    value={s.label}
                    onChange={(e) => renameScheme(s.id, e.target.value)}
                    disabled={busy}
                    className="flex-1 min-w-0 border border-gray-200 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                  <span className="hidden sm:block text-xs text-gray-400 w-40 truncate">
                    {pinned ? 'As designed (no recolor)' : (s.colorIds ?? []).map(labelOf).join(' · ')}
                  </span>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => moveScheme(s.id, -1)}
                      disabled={busy || i <= 1}
                      aria-label={`Move ${s.label} up`}
                      className="w-7 h-7 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveScheme(s.id, 1)}
                      disabled={busy || pinned || i >= schemes.length - 1}
                      aria-label={`Move ${s.label} down`}
                      className="w-7 h-7 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => removeScheme(s.id)}
                      disabled={busy || pinned}
                      aria-label={`Remove ${s.label}`}
                      title={pinned ? 'As designed can’t be removed' : 'Remove'}
                      className="w-7 h-7 rounded border border-gray-200 text-red-500 hover:bg-red-50 disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                      ×
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Add-a-swatch composer */}
          <div className="mt-4 rounded-xl border border-dashed border-gray-300 p-4">
            <p className="text-sm font-medium text-gray-800">Add a swatch</p>
            <p className="text-xs text-gray-500 mt-0.5 mb-3">
              Name it, then tap colors to build the pattern (tap again to add more; the lights cycle
              through them in order). One color = a solid.
            </p>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <input
                aria-label="New swatch name"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="e.g. Red &amp; Gold"
                disabled={busy}
                className="border border-gray-200 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
              {newColors.length > 0 && (
                <span
                  aria-hidden
                  className="w-6 h-6 rounded-full ring-1 ring-black/10"
                  style={swatchStyle(newColors, hexOf)}
                />
              )}
              <button
                type="button"
                onClick={addScheme}
                disabled={busy || !newLabel.trim() || newColors.length === 0}
                className="rounded-md bg-emerald-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Add
              </button>
            </div>
            {newColors.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 mb-3">
                {newColors.map((id, idx) => (
                  <button
                    key={`${id}-${idx}`}
                    type="button"
                    onClick={() => setNewColors((c) => c.filter((_, k) => k !== idx))}
                    aria-label={`Remove ${labelOf(id)} from new swatch`}
                    className="w-6 h-6 rounded-full ring-1 ring-black/10 hover:ring-black/40"
                    style={{ background: hexOf(id) }}
                  />
                ))}
                <button
                  type="button"
                  onClick={() => setNewColors([])}
                  className="text-xs text-gray-500 hover:text-gray-800 underline ml-1"
                >
                  Clear
                </button>
              </div>
            )}
            <div className="flex flex-wrap gap-1.5" aria-label="Palette colors">
              {paletteChips.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setNewColors((cur) => [...cur, c.id])}
                  disabled={busy}
                  aria-label={`Add ${c.label}`}
                  title={c.label}
                  className="w-7 h-7 rounded-full ring-1 ring-black/10 hover:scale-110 transition-transform disabled:opacity-40"
                  style={{ background: c.hex }}
                />
              ))}
            </div>
          </div>

          {/* Build-your-own palette */}
          <div className="mt-5">
            <p className="text-sm font-medium text-gray-800">&ldquo;Build your own&rdquo; palette</p>
            <p className="text-xs text-gray-500 mt-0.5 mb-2.5">
              Which colors customers can use to build their own pattern on the portal.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {paletteChips.map((c) => {
                const on = buildableSet.has(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => toggleBuildable(c.id)}
                    disabled={busy}
                    aria-pressed={on}
                    title={c.label}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                      on
                        ? 'border-emerald-600 bg-emerald-50 text-emerald-900'
                        : 'border-gray-200 text-gray-400 hover:border-gray-300'
                    }`}
                  >
                    <span
                      aria-hidden
                      className={`w-3.5 h-3.5 rounded-full ring-1 ring-black/10 ${on ? '' : 'opacity-40'}`}
                      style={{ background: c.hex }}
                    />
                    {c.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Save bar */}
          <div className="mt-5 flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={busy || !dirty}
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Save changes
            </button>
            <span className="text-sm" aria-live="polite">
              {status === 'saving' && <span className="text-gray-400">Saving…</span>}
              {status === 'saved' && <span className="text-emerald-600">Saved</span>}
              {status === 'error' && <span className="text-red-600">{error ?? 'Something went wrong'}</span>}
              {status === 'idle' && dirty && <span className="text-gray-400">Unsaved changes</span>}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
