// src/app/inventory/bindings/page.tsx
'use client';

// Binding editor (#82 Slice 1b-ii): map each billable design concept → a real
// Thunder/YLL SKU, plus roof-feature clip rules. Mirrors the #32 Settings page
// (client page + useEffect load + a single explicit Save → PUT). The concept
// vocabulary + key format come from src/lib/inventory/concepts.ts so the UI and
// the Slice 2 materials engine agree. Loads the catalog for the SKU pickers; the
// pickers are category-scoped where it helps, and clip + decoration-fee SKUs are
// pre-filled from the known values (operator reviews + Saves).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';
import { SkuPicker } from '@/components/inventory/SkuPicker';
import type { CatalogItem } from '@/lib/inventory/catalog';
import type { Bindings, ClipRules, InventoryBindings } from '@/lib/inventory/bindings';
import {
  bulbC9Rows, BISTRO_KEY, MINI_CATEGORY, miniKey,
  CLIP_FEATURES,
  wreathBaseRows, wreathBowRows, wreathFeeRows,
  garlandBaseRows, GARLAND_BOW_KEY, GARLAND_FEE_KEY,
  SPRITZER_SIZES, spritzerColorRows, spritzerPoleKey,
  WIRE_C9_KEY, WIRE_MAGNETIC_KEY,
  buildSeedBindings, buildSeedClipRules,
} from '@/lib/inventory/concepts';

type Status = 'idle' | 'saving' | 'saved' | 'error';
const TABS = [
  { id: 'bulbs', label: 'Bulb colors' },
  { id: 'mini', label: 'Mini lights' },
  { id: 'clips', label: 'Clips / roof' },
  { id: 'wreaths', label: 'Wreaths' },
  { id: 'garland', label: 'Garland' },
  { id: 'spritzers', label: 'Spritzers' },
] as const;

const strVal = (b: Bindings, key: string) => (typeof b[key] === 'string' ? (b[key] as string) : '');
const effCat = (i: CatalogItem) => i.yll_category ?? i.category;

export default function BindingsPage() {
  const [tab, setTab] = useState<(typeof TABS)[number]['id']>('bulbs');
  const [bindings, setBindings] = useState<Bindings>({});
  const [clipRules, setClipRules] = useState<ClipRules>({});
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Pre-fill seeds (operator reviews + Saves): wreath/garland base + bow + fee,
    // standard mini strands, the spritzer colors we carry, and clip SKUs. See
    // concepts.ts buildSeed*. Saved bindings win; seeds fill the gaps.
    const seededBindings = buildSeedBindings();
    const seededClips = buildSeedClipRules();

    void (async () => {
      let savedB: Bindings = {};
      let savedC: ClipRules = {};
      try {
        const [bRes, cRes] = await Promise.all([
          fetch('/api/inventory/bindings'),
          fetch('/api/inventory/catalog'),
        ]);
        if (bRes.ok) {
          const b = (await bRes.json()) as InventoryBindings;
          savedB = b.bindings ?? {};
          savedC = b.clipRules ?? {};
        }
        if (cRes.ok) {
          const c = (await cRes.json()) as CatalogItem[];
          if (!cancelled) setCatalog(Array.isArray(c) ? c : []);
        }
      } catch {
        // keep the seeds; staff can still save
      }
      if (!cancelled) {
        setBindings({ ...seededBindings, ...savedB }); // saved wins; seeds fill gaps
        setClipRules({ ...seededClips, ...savedC });
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Catalog grouped by effective category, for scoping the pickers.
  const byCat = useMemo(() => {
    const m = new Map<string, CatalogItem[]>();
    for (const it of catalog) {
      const c = effCat(it);
      const arr = m.get(c);
      if (arr) arr.push(it);
      else m.set(c, [it]);
    }
    return m;
  }, [catalog]);
  // Scope a picker to a category, but fall back to the full catalog if that
  // category is empty (so a wrong guess never yields an unusable empty picker).
  const scoped = (cat: string) => {
    const s = byCat.get(cat);
    return s && s.length ? s : catalog;
  };

  // Mini lights: one row per distinct catalog color, picker scoped to that color.
  const miniByColor = useMemo(() => {
    const m = new Map<string, CatalogItem[]>();
    for (const it of catalog) {
      if (effCat(it) !== MINI_CATEGORY) continue;
      const color = (it.color ?? '').trim() || '(no color)';
      const arr = m.get(color);
      if (arr) arr.push(it);
      else m.set(color, [it]);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalog]);

  // ── mutators (empty value ⇒ delete the key, matching normalizeBindings) ──
  const setBinding = (key: string, sku: string) =>
    setBindings((b) => {
      const n = { ...b };
      if (sku) n[key] = sku;
      else delete n[key];
      return n;
    });

  const setClipSku = (feature: string, sku: string) =>
    setClipRules((cr) => {
      const cur = { ...(cr[feature] ?? {}) };
      if (sku) cur.sku = sku;
      else delete cur.sku;
      const n = { ...cr };
      if (Object.keys(cur).length) n[feature] = cur;
      else delete n[feature];
      return n;
    });

  const setClipPerFt = (feature: string, raw: string) =>
    setClipRules((cr) => {
      const cur = { ...(cr[feature] ?? {}) };
      const num = Number(raw);
      if (raw.trim() !== '' && Number.isFinite(num) && num >= 0) cur.perFt = num;
      else delete cur.perFt;
      const n = { ...cr };
      if (Object.keys(cur).length) n[feature] = cur;
      else delete n[feature];
      return n;
    });

  const save = useCallback(async () => {
    setStatus('saving');
    setErrorMsg(null);
    try {
      const res = await fetch('/api/inventory/bindings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindings, clipRules }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const saved = (await res.json()) as InventoryBindings;
      setBindings(saved.bindings ?? {});
      setClipRules(saved.clipRules ?? {});
      setStatus('saved');
      window.setTimeout(() => setStatus('idle'), 1800);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Save failed');
    }
  }, [bindings, clipRules]);

  // One bound picker for a string-valued concept row.
  const pick = (key: string, cat: CatalogItem[], aria: string) => (
    <SkuPicker
      catalog={cat}
      value={strVal(bindings, key)}
      onChange={(s) => setBinding(key, s)}
      ariaLabel={aria}
    />
  );

  return (
    <OperatorShell active="inventory">
      <main className="max-w-3xl mx-auto">
        <InventorySubNav active="bindings" />

        <div className="mb-5">
          <h1 className="text-xl font-semibold text-gray-900">Bindings</h1>
          <p className="text-sm text-gray-500">
            Connect each design concept to the real SKU it orders. Empty = unbound (no SKU ordered for
            it yet). Clip + decoration-fee SKUs are pre-filled — review and Save.
          </p>
        </div>

        <div className="flex gap-1 border-b border-gray-200 mb-5 flex-wrap">
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
          <p className="text-sm text-gray-500 py-10 text-center">Loading bindings…</p>
        ) : (
          <>
            {tab === 'bulbs' && (
              <>
                <section className="mb-6">
                  <h2 className="text-sm font-semibold text-gray-800 mb-1">C9 bulbs</h2>
                  {bulbC9Rows().map((row) => (
                    <Row key={row.key} label={row.label}>
                      {pick(row.key, scoped('Bulb'), `${row.label} C9 SKU`)}
                    </Row>
                  ))}
                </section>
                <section className="mb-6">
                  <h2 className="text-sm font-semibold text-gray-800 mb-1">Bistro</h2>
                  <p className="text-[11px] text-gray-400 mb-1">Bistro comes in Warm White only.</p>
                  <Row label="Warm White">{pick(BISTRO_KEY, scoped('Bistro'), 'Bistro Warm White SKU')}</Row>
                </section>
              </>
            )}

            {tab === 'mini' && (
              <section>
                <p className="text-xs text-gray-400 mb-3">
                  Every mini-light color in the catalog ({miniByColor.length}). Pick the standard SKU per
                  color — some colors (e.g. Warm White) have several variants.
                </p>
                {miniByColor.length === 0 ? (
                  <p className="text-sm text-gray-400 py-6">No mini lights in the catalog.</p>
                ) : (
                  miniByColor.map(([color, items]) => (
                    <Row key={color} label={color} hint={items.length > 1 ? `${items.length} variants` : undefined}>
                      {pick(miniKey(color), items, `${color} mini-light SKU`)}
                    </Row>
                  ))
                )}
              </section>
            )}

            {tab === 'clips' && (
              <section>
                <p className="text-xs text-gray-400 mb-3">
                  Hard rules: no window lighting, no C7 clips. Spritzer stakes are NOT clips. SKUs are
                  pre-filled — adjust clips/ft and Save.
                </p>
                <div className="mb-5">
                  <h2 className="text-sm font-semibold text-gray-800 mb-1">Socket wire</h2>
                  <p className="text-[11px] text-gray-400 mb-1">
                    Ordered per foot of roofline. Magnetic wire is used on metal roofs (which take no clips).
                  </p>
                  <Row label="C9 socket wire (standard)">{pick(WIRE_C9_KEY, scoped('Wire'), 'C9 socket wire SKU')}</Row>
                  <Row label="Magnetic socket wire (metal roofs)">{pick(WIRE_MAGNETIC_KEY, scoped('Wire'), 'Magnetic socket wire SKU')}</Row>
                </div>
                {CLIP_FEATURES.map((f) => {
                  const rule = clipRules[f.id] ?? {};
                  const sku = typeof rule.sku === 'string' ? rule.sku : '';
                  const perFt = typeof rule.perFt === 'number' ? String(rule.perFt) : '';
                  return (
                    <Row key={f.id} label={f.label} hint={f.hint}>
                      <div className="flex items-center gap-2">
                        <SkuPicker
                          catalog={scoped('Hardware')}
                          value={sku}
                          onChange={(s) => setClipSku(f.id, s)}
                          ariaLabel={`${f.label} clip SKU`}
                        />
                        <label className="flex items-center gap-1 text-xs text-gray-500">
                          clips/ft
                          <input
                            type="number"
                            min={0}
                            step={0.05}
                            value={perFt}
                            onChange={(e) => setClipPerFt(f.id, e.target.value)}
                            className="w-16 border border-gray-300 rounded px-1.5 py-1 text-sm"
                            aria-label={`${f.label} clips per foot`}
                          />
                        </label>
                      </div>
                    </Row>
                  );
                })}
              </section>
            )}

            {tab === 'wreaths' && (
              <>
                <section className="mb-6">
                  <h2 className="text-sm font-semibold text-gray-800 mb-1">Base wreath (per size)</h2>
                  {wreathBaseRows().map((row) => (
                    <Row key={row.key} label={row.label}>{pick(row.key, catalog, `${row.label} wreath SKU`)}</Row>
                  ))}
                </section>
                <section className="mb-6">
                  <h2 className="text-sm font-semibold text-gray-800 mb-1">Bow (decorated only)</h2>
                  {wreathBowRows().map((row) => (
                    <Row key={row.key} label={row.label} hint={row.hint}>{pick(row.key, scoped('Bow'), `${row.label} bow SKU`)}</Row>
                  ))}
                </section>
                <section className="mb-6">
                  <h2 className="text-sm font-semibold text-gray-800 mb-1">Decoration fee (decorated only)</h2>
                  {wreathFeeRows().map((row) => (
                    <Row key={row.key} label={row.label}>{pick(row.key, scoped('Decoration Fee'), `${row.label} decoration fee SKU`)}</Row>
                  ))}
                </section>
              </>
            )}

            {tab === 'garland' && (
              <>
                <section className="mb-6">
                  <h2 className="text-sm font-semibold text-gray-800 mb-1">Base garland (per length)</h2>
                  {garlandBaseRows().map((row) => (
                    <Row key={row.key} label={row.label}>{pick(row.key, catalog, `${row.label} garland SKU`)}</Row>
                  ))}
                </section>
                <section className="mb-6">
                  <h2 className="text-sm font-semibold text-gray-800 mb-1">Bow + decoration (decorated only)</h2>
                  <Row label="Bow" hint='12" bow'>{pick(GARLAND_BOW_KEY, scoped('Bow'), 'Garland bow SKU')}</Row>
                  <Row label="Decoration fee">{pick(GARLAND_FEE_KEY, scoped('Decoration Fee'), 'Garland decoration fee SKU')}</Row>
                </section>
              </>
            )}

            {tab === 'spritzers' && (
              <>
                <p className="text-xs text-gray-400 mb-3">
                  Bind each color you stock per size; the pole is the same across colors. Leave colors you
                  don&apos;t carry empty (32&quot; is white/warm white only).
                </p>
                {SPRITZER_SIZES.map((size) => (
                  <section key={size} className="mb-6">
                    <h2 className="text-sm font-semibold text-gray-800 mb-1">{size}&quot; spritzers</h2>
                    {spritzerColorRows(size).map((row) => (
                      <Row key={row.key} label={row.label}>{pick(row.key, scoped('Spritzer/Sparklers'), `${size}" ${row.label} spritzer SKU`)}</Row>
                    ))}
                    <Row label="Pole (metal stake)" hint="same pole for every color this size">
                      {pick(spritzerPoleKey(size), scoped('Spritzer/Sparklers'), `${size}" spritzer pole SKU`)}
                    </Row>
                  </section>
                ))}
              </>
            )}

            <div className="flex items-center gap-3 mt-6 sticky bottom-0 bg-[var(--op-bg)] py-3">
              <button
                type="button"
                onClick={save}
                className="text-sm font-semibold text-white bg-green-600 hover:bg-green-700 rounded-md px-4 py-1.5"
              >
                Save bindings
              </button>
              {status !== 'idle' && (
                <span
                  role="status"
                  className={`text-sm ${
                    status === 'error' ? 'text-red-600' : status === 'saved' ? 'text-green-700' : 'text-gray-500'
                  }`}
                >
                  {status === 'saving' && 'Saving…'}
                  {status === 'saved' && 'Saved.'}
                  {status === 'error' && `Save failed: ${errorMsg}`}
                </span>
              )}
            </div>
          </>
        )}
      </main>
    </OperatorShell>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-b border-gray-100">
      <div className="min-w-0">
        <div className="text-sm text-gray-700">{label}</div>
        {hint && <div className="text-[11px] text-gray-400 max-w-md">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
