// src/app/inventory/bindings/page.tsx
'use client';

// Binding editor (#82 Slice 1b-ii): map each billable design concept → a real
// Thunder SKU, plus roof-feature clip rules. Mirrors the #32 Settings page
// (client page + useEffect load + a single explicit Save → PUT). The concept
// vocabulary + key format come from src/lib/inventory/concepts.ts so the UI and
// the Slice 2 materials engine agree. Loads the catalog for the SKU picker.

import { useCallback, useEffect, useState } from 'react';
import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';
import { SkuPicker } from '@/components/inventory/SkuPicker';
import type { CatalogItem } from '@/lib/inventory/catalog';
import type { Bindings, ClipRules, InventoryBindings } from '@/lib/inventory/bindings';
import {
  bulbGroups, wreathRows, garlandRows, miniRows, spritzerRows, CLIP_FEATURES,
} from '@/lib/inventory/concepts';

type Status = 'idle' | 'saving' | 'saved' | 'error';
const TABS = [
  { id: 'bulbs', label: 'Bulb colors' },
  { id: 'clips', label: 'Clips / roof' },
  { id: 'wreaths', label: 'Wreaths' },
  { id: 'garland', label: 'Garland' },
  { id: 'spritzers', label: 'Spritzers' },
  { id: 'mini', label: 'Mini wraps' },
] as const;

const strVal = (b: Bindings, key: string) => (typeof b[key] === 'string' ? (b[key] as string) : '');

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
    void (async () => {
      try {
        const [bRes, cRes] = await Promise.all([
          fetch('/api/inventory/bindings'),
          fetch('/api/inventory/catalog'),
        ]);
        if (bRes.ok) {
          const b = (await bRes.json()) as InventoryBindings;
          if (!cancelled) {
            setBindings(b.bindings ?? {});
            setClipRules(b.clipRules ?? {});
          }
        }
        if (cRes.ok) {
          const c = (await cRes.json()) as CatalogItem[];
          if (!cancelled) setCatalog(Array.isArray(c) ? c : []);
        }
      } catch {
        // keep empty state; staff can still save
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── mutators (empty value ⇒ delete the key, matching normalizeBindings) ──
  const setBinding = (key: string, sku: string) =>
    setBindings((b) => {
      const n = { ...b };
      if (sku) n[key] = sku;
      else delete n[key];
      return n;
    });

  const setBundleField = (key: string, field: string, sku: string) =>
    setBindings((b) => {
      const cur: Record<string, string> =
        typeof b[key] === 'object' ? { ...(b[key] as Record<string, string>) } : {};
      if (sku) cur[field] = sku;
      else delete cur[field];
      const n = { ...b };
      if (Object.keys(cur).length) n[key] = cur;
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
      if (raw.trim() !== '' && Number.isFinite(num)) cur.perFt = num;
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

  return (
    <OperatorShell active="inventory">
      <main className="max-w-3xl mx-auto">
        <InventorySubNav active="bindings" />

        <div className="mb-5">
          <h1 className="text-xl font-semibold text-gray-900">Bindings</h1>
          <p className="text-sm text-gray-500">
            Connect each design concept to the real Thunder SKU it orders. Empty = unbound (no SKU
            ordered for it yet).
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
            {tab === 'bulbs' &&
              bulbGroups().map((g) => (
                <section key={g.type.id} className="mb-6">
                  <h2 className="text-sm font-semibold text-gray-800 mb-1">{g.type.label} bulbs</h2>
                  {g.rows.map((row) => (
                    <Row key={row.key} label={row.label}>
                      <SkuPicker
                        catalog={catalog}
                        value={strVal(bindings, row.key)}
                        onChange={(sku) => setBinding(row.key, sku)}
                        ariaLabel={`${row.label} ${g.type.label} SKU`}
                      />
                    </Row>
                  ))}
                </section>
              ))}

            {tab === 'clips' && (
              <section>
                <p className="text-xs text-gray-400 mb-3">
                  Hard rules: no window lighting, no C7 clips. Spritzer stakes are NOT clips.
                </p>
                {CLIP_FEATURES.map((f) => {
                  const rule = clipRules[f.id] ?? {};
                  const sku = typeof rule.sku === 'string' ? rule.sku : '';
                  const perFt = typeof rule.perFt === 'number' ? String(rule.perFt) : '';
                  return (
                    <Row key={f.id} label={f.label} hint={f.hint}>
                      <div className="flex items-center gap-2">
                        <SkuPicker
                          catalog={catalog}
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
              <section>
                {wreathRows().map((row) => (
                  <Row key={row.key} label={row.label}>
                    <SkuPicker catalog={catalog} value={strVal(bindings, row.key)} onChange={(s) => setBinding(row.key, s)} ariaLabel={`${row.label} SKU`} />
                  </Row>
                ))}
              </section>
            )}

            {tab === 'garland' && (
              <section>
                {garlandRows().map((row) => (
                  <Row key={row.key} label={row.label}>
                    <SkuPicker catalog={catalog} value={strVal(bindings, row.key)} onChange={(s) => setBinding(row.key, s)} ariaLabel={`${row.label} SKU`} />
                  </Row>
                ))}
              </section>
            )}

            {tab === 'spritzers' && (
              <section>
                <p className="text-xs text-gray-400 mb-3">
                  Each spritzer binds two SKUs — the spritzer itself + its metal stake pole.
                </p>
                {spritzerRows().map((row) => {
                  const bundle =
                    typeof bindings[row.key] === 'object' ? (bindings[row.key] as Record<string, string>) : {};
                  return (
                    <Row key={row.key} label={row.label}>
                      <div className="flex flex-col gap-1.5">
                        {row.fields.map((f) => (
                          <label key={f.id} className="flex items-center gap-2 text-xs text-gray-500">
                            <span className="w-28 text-right">{f.label}</span>
                            <SkuPicker
                              catalog={catalog}
                              value={bundle[f.id] ?? ''}
                              onChange={(s) => setBundleField(row.key, f.id, s)}
                              ariaLabel={`${row.label} ${f.label} SKU`}
                            />
                          </label>
                        ))}
                      </div>
                    </Row>
                  );
                })}
              </section>
            )}

            {tab === 'mini' && (
              <section>
                {miniRows().map((row) => (
                  <Row key={row.key} label={row.label}>
                    <SkuPicker catalog={catalog} value={strVal(bindings, row.key)} onChange={(s) => setBinding(row.key, s)} ariaLabel={`${row.label} SKU`} />
                  </Row>
                ))}
              </section>
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
