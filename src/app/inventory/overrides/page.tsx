// src/app/inventory/overrides/page.tsx
'use client';

// Catalog overrides (#82 Slice 1b-iii): hide categories the materials engine
// shouldn't use, and lock sold-out items so the engine won't order them. The
// item list is searchable + paginated (Naldo's locked choice — 831 SKUs). Unlike
// the binding editor, this page saves INSTANTLY per toggle (a paginated list has
// no single Save), via PATCH /api/inventory/catalog + PUT /api/inventory/categories.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';
import type { CatalogItem } from '@/lib/inventory/catalog';
import { searchCatalog } from '@/lib/inventory/skuSearch';

const PAGE_SIZE = 25;
const effCat = (it: CatalogItem) => it.yll_category ?? it.category;

export default function OverridesPage() {
  const [tab, setTab] = useState<'categories' | 'items'>('categories');
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [hidden, setHidden] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [cRes, hRes] = await Promise.all([
          fetch('/api/inventory/catalog'),
          fetch('/api/inventory/categories'),
        ]);
        if (cRes.ok) {
          const c = (await cRes.json()) as CatalogItem[];
          if (!cancelled) setCatalog(Array.isArray(c) ? c : []);
        }
        if (hRes.ok) {
          const h = (await hRes.json()) as { hiddenCategories?: string[] };
          if (!cancelled) setHidden(h.hiddenCategories ?? []);
        }
      } catch {
        // keep empty state
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const flash = (msg: string) => {
    setNote(msg);
    window.setTimeout(() => setNote(null), 1600);
  };

  // ── category show/hide (instant PUT) ──
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of catalog) counts.set(effCat(it), (counts.get(effCat(it)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalog]);

  const toggleCategory = useCallback(
    async (cat: string, visible: boolean) => {
      const next = visible ? hidden.filter((c) => c !== cat) : [...hidden, cat];
      const prev = hidden;
      setHidden(next); // optimistic
      try {
        const res = await fetch('/api/inventory/categories', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hiddenCategories: next }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const saved = (await res.json()) as { hiddenCategories?: string[] };
        setHidden(saved.hiddenCategories ?? next);
        flash('Saved.');
      } catch {
        setHidden(prev); // revert
        flash('Save failed.');
      }
    },
    [hidden],
  );

  // ── per-item lock (instant PATCH) ──
  const patchItem = useCallback(
    async (sku: string, patch: { locked?: boolean; yll_category?: string | null }) => {
      const prevItem = catalog.find((c) => c.sku === sku);
      setCatalog((cs) => cs.map((c) => (c.sku === sku ? { ...c, ...patch } : c)));
      try {
        const res = await fetch('/api/inventory/catalog', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sku, ...patch }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // No reconcile: the PATCH returns no row and the optimistic value equals
        // what we sent, so local state is already authoritative.
        flash('Saved.');
      } catch {
        // Revert only THIS row (by sku) so a concurrent save to another row isn't clobbered.
        if (prevItem) setCatalog((cs) => cs.map((c) => (c.sku === sku ? prevItem : c)));
        flash('Save failed.');
      }
    },
    [catalog],
  );

  return (
    <OperatorShell active="inventory">
      <main className="max-w-4xl mx-auto">
        <InventorySubNav active="overrides" />

        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Overrides</h1>
            <p className="text-sm text-gray-500">Hide unused categories and lock sold-out items. Saves instantly.</p>
          </div>
          {note && <span role="status" className="text-sm text-gray-500">{note}</span>}
        </div>

        <div className="flex gap-1 border-b border-gray-200 mb-5">
          {(['categories', 'items'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 capitalize ${
                tab === t ? 'border-green-600 text-green-700' : 'border-transparent text-gray-500 hover:text-gray-800'
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-sm text-gray-500 py-10 text-center">Loading catalog…</p>
        ) : tab === 'categories' ? (
          <CategoriesTab categories={categories} hidden={hidden} onToggle={toggleCategory} />
        ) : (
          <ItemsTab catalog={catalog} hidden={hidden} onPatch={patchItem} />
        )}
      </main>
    </OperatorShell>
  );
}

function CategoriesTab({
  categories,
  hidden,
  onToggle,
}: {
  categories: [string, number][];
  hidden: string[];
  onToggle: (cat: string, visible: boolean) => void;
}) {
  const hiddenSet = new Set(hidden);
  if (categories.length === 0) {
    return <p className="text-sm text-gray-400 py-6">No catalog imported yet.</p>;
  }
  return (
    <div className="space-y-1">
      {categories.map(([cat, count]) => {
        const visible = !hiddenSet.has(cat);
        return (
          <label
            key={cat}
            className="flex items-center justify-between gap-4 py-2 px-2 border border-gray-100 rounded hover:bg-gray-50"
          >
            <span className="text-sm text-gray-700">
              {cat} <span className="text-xs text-gray-400">({count})</span>
            </span>
            <span className="flex items-center gap-2 text-xs text-gray-500">
              {visible ? 'Visible' : 'Hidden'}
              <input
                type="checkbox"
                checked={visible}
                onChange={(e) => onToggle(cat, e.target.checked)}
                className="w-4 h-4"
                aria-label={`Toggle ${cat} visibility`}
              />
            </span>
          </label>
        );
      })}
    </div>
  );
}

function ItemsTab({
  catalog,
  hidden,
  onPatch,
}: {
  catalog: CatalogItem[];
  hidden: string[];
  onPatch: (sku: string, patch: { locked?: boolean; yll_category?: string | null }) => void;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  // WT-23: a hidden category vanishes from this list too — the categories tab's
  // "Hidden" toggle previously had zero effect here, only re-rendering itself.
  const filtered = useMemo(() => searchCatalog(catalog, query, catalog.length, hidden), [catalog, query, hidden]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clamped = Math.min(page, pages - 1);
  const slice = filtered.slice(clamped * PAGE_SIZE, clamped * PAGE_SIZE + PAGE_SIZE);

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setPage(0); }}
          placeholder="Search SKU, name, or category…"
          className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm"
          aria-label="Search catalog"
        />
        <span className="text-xs text-gray-400 shrink-0">{filtered.length} items</span>
      </div>

      <div className="border border-gray-100 rounded divide-y divide-gray-100">
        {slice.length === 0 ? (
          <p className="text-sm text-gray-400 px-3 py-6">No matches.</p>
        ) : (
          slice.map((it) => (
            <div key={it.sku} className="flex items-center gap-3 px-3 py-2">
              <span className="font-mono text-xs text-gray-500 w-24 shrink-0">{it.sku}</span>
              <span className="flex-1 truncate text-sm text-gray-800" title={it.name}>{it.name}</span>
              <span className="text-[11px] text-gray-400 w-28 truncate shrink-0">{it.yll_category ?? it.category}</span>
              <label className="flex items-center gap-1.5 text-xs text-gray-500 shrink-0">
                <input
                  type="checkbox"
                  checked={it.locked}
                  onChange={(e) => onPatch(it.sku, { locked: e.target.checked })}
                  className="w-4 h-4"
                  aria-label={`Lock ${it.sku}`}
                />
                {it.locked ? <span className="text-amber-600">Sold out</span> : 'Available'}
              </label>
            </div>
          ))
        )}
      </div>

      <div className="flex items-center justify-between mt-3 text-sm text-gray-500">
        <button
          type="button"
          disabled={clamped <= 0}
          onClick={() => setPage(clamped - 1)}
          className="px-3 py-1 rounded border border-gray-300 disabled:opacity-40 hover:bg-gray-50"
        >
          ← Prev
        </button>
        <span>Page {clamped + 1} of {pages}</span>
        <button
          type="button"
          disabled={clamped >= pages - 1}
          onClick={() => setPage(clamped + 1)}
          className="px-3 py-1 rounded border border-gray-300 disabled:opacity-40 hover:bg-gray-50"
        >
          Next →
        </button>
      </div>
    </div>
  );
}
