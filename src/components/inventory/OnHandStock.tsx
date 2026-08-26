// src/components/inventory/OnHandStock.tsx
'use client';

// On-hand stock table (#82 Slice 1c): a curated list of stocked SKUs with an
// on-hand count, reorder point, and storage location. Add via the SKU picker;
// fields save inline on blur (optimistic; reload on error). Mirrors the overrides
// page's instant-save pattern.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';
import { SkuPicker } from '@/components/inventory/SkuPicker';
import type { CatalogItem } from '@/lib/inventory/catalog';
import { toQty, type OnHandRow } from '@/lib/inventory/onHand';
import { SkeletonBar } from '@/components/ui/LoadingSkeleton';

const effCat = (i: CatalogItem) => i.yll_category ?? i.category;
const isLow = (r: OnHandRow) => r.reorder_point > 0 && r.on_hand_qty <= r.reorder_point;

export function OnHandStock() {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [rows, setRows] = useState<OnHandRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [lowOnly, setLowOnly] = useState(false);

  const load = useCallback(async () => {
    const [oRes, cRes] = await Promise.all([
      fetch('/api/inventory/on-hand'),
      fetch('/api/inventory/catalog'),
    ]);
    if (oRes.ok) {
      const o = (await oRes.json()) as OnHandRow[];
      setRows(Array.isArray(o) ? o : []);
    }
    if (cRes.ok) {
      const c = (await cRes.json()) as CatalogItem[];
      setCatalog(Array.isArray(c) ? c : []);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await load();
      } catch {
        // keep empty state
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [load]);

  const flash = (msg: string) => {
    setNote(msg);
    window.setTimeout(() => setNote(null), 1600);
  };

  const byId = useMemo(() => new Map(catalog.map((c) => [c.sku, c])), [catalog]);
  const stockedSkus = useMemo(() => new Set(rows.map((r) => r.sku)), [rows]);

  // PUT one or more fields; the optimistic local update is already applied.
  const persist = useCallback(async (sku: string, patch: Partial<OnHandRow>) => {
    try {
      const res = await fetch('/api/inventory/on-hand', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sku, ...patch }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      flash('Saved.');
    } catch {
      // Leave the typed value in place — reloading the whole list would wipe
      // edits in flight on other rows. The operator sees the failure and re-saves.
      flash('Save failed — retry.');
    }
  }, []);

  const addItem = useCallback(
    async (sku: string) => {
      if (!sku) return;
      if (stockedSkus.has(sku)) {
        flash('Already in the list.');
        return;
      }
      setRows((rs) => [...rs, { sku, on_hand_qty: 0, reorder_point: 0, storage_location: null }]);
      await persist(sku, {});
    },
    [stockedSkus, persist],
  );

  const editLocal = (sku: string, patch: Partial<OnHandRow>) =>
    setRows((rs) => rs.map((r) => (r.sku === sku ? { ...r, ...patch } : r)));

  const remove = useCallback(
    async (sku: string) => {
      const prevRow = rows.find((r) => r.sku === sku);
      setRows((rs) => rs.filter((r) => r.sku !== sku));
      try {
        const res = await fetch('/api/inventory/on-hand', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sku }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        flash('Removed.');
      } catch {
        // Restore only this row, so a concurrent edit to another row isn't clobbered.
        if (prevRow) setRows((rs) => [...rs, prevRow]);
        flash('Remove failed.');
      }
    },
    [rows],
  );

  const lowCount = useMemo(() => rows.filter(isLow).length, [rows]);
  const view = useMemo(() => {
    let list = lowOnly ? rows.filter(isLow) : rows;
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter((r) => {
        const c = byId.get(r.sku);
        const name = (c?.name ?? '').toLowerCase();
        const cat = (c ? effCat(c) : '').toLowerCase();
        return r.sku.toLowerCase().includes(q) || name.includes(q) || cat.includes(q);
      });
    }
    return list;
  }, [rows, lowOnly, query, byId]);

  return (
    <OperatorShell active="inventory">
      <main className="max-w-4xl mx-auto">
        <InventorySubNav active="stock" />

        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">On-Hand Stock</h1>
            <p className="text-sm text-gray-500">
              What the warehouse has on hand. Add the SKUs you stock, then keep the counts current. Saves instantly.
            </p>
          </div>
          {note && <span role="status" className="text-sm text-gray-500">{note}</span>}
        </div>

        <div className="flex items-center gap-3 mb-5">
          <span className="text-sm text-gray-600 shrink-0">Add stocked item:</span>
          <SkuPicker
            catalog={catalog}
            value=""
            onChange={addItem}
            ariaLabel="Add a SKU to the stock list"
            placeholder="Search SKU or name to add…"
          />
        </div>

        <div className="flex items-center gap-3 mb-3">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search stocked items…"
            className="flex-1 border border-gray-300 rounded px-2 py-1.5 text-sm"
            aria-label="Search stocked items"
          />
          <label className="flex items-center gap-1.5 text-sm text-gray-600 shrink-0">
            <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} className="w-4 h-4" />
            Low stock only{lowCount > 0 ? ` (${lowCount})` : ''}
          </label>
        </div>

        {loading ? (
          // Row 410: mirrors the stock table below it — the same bordered box
          // and header strip, then rows at the real px-3 py-2 rhythm.
          <div role="status" aria-busy="true" className="border border-gray-100 rounded">
            <div className="px-3 py-2 border-b border-gray-100">
              <SkeletonBar className="h-3 w-full" />
            </div>
            {/* Row 410 fix round (staff lens LOW): rows are h-11 — the real
                rows run two lines (~44px), and h-8 undershot them. */}
            <div className="p-3 flex flex-col gap-3">
              <SkeletonBar className="h-11" />
              <SkeletonBar className="h-11" />
              <SkeletonBar className="h-11" />
              <SkeletonBar className="h-11" />
            </div>
            <span className="sr-only">Loading stock…</span>
          </div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-gray-400 py-10 text-center">No stocked items yet — add one above.</p>
        ) : (
          <div className="border border-gray-100 rounded">
            <div className="flex items-center gap-3 px-3 py-2 text-[11px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
              <span className="w-24 shrink-0">SKU</span>
              <span className="flex-1">Item</span>
              <span className="w-20 text-center shrink-0">On hand</span>
              <span className="w-20 text-center shrink-0">Reorder</span>
              <span className="w-28 shrink-0">Location</span>
              <span className="w-14 shrink-0" />
            </div>
            {view.length === 0 ? (
              <p className="text-sm text-gray-400 px-3 py-6">No matches.</p>
            ) : (
              view.map((r) => {
                const c = byId.get(r.sku);
                const low = isLow(r);
                return (
                  <div key={r.sku} className={`flex items-center gap-3 px-3 py-2 border-b border-gray-100 ${low ? 'bg-amber-50' : ''}`}>
                    <span className="font-mono text-xs text-gray-500 w-24 shrink-0">{r.sku}</span>
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-sm text-gray-800" title={c?.name ?? ''}>
                        {c?.name ?? <span className="text-amber-600">⚠ not in catalog</span>}
                      </span>
                      <span className="block text-[11px] text-gray-400">
                        {c ? effCat(c) : ''}
                        {low && <span className="ml-2 text-amber-600 font-medium uppercase">Low</span>}
                      </span>
                    </span>
                    <input
                      type="number" min={0} aria-label={`${r.sku} on hand`}
                      value={r.on_hand_qty}
                      onChange={(e) => editLocal(r.sku, { on_hand_qty: toQty(e.target.value) })}
                      onBlur={() => persist(r.sku, { on_hand_qty: r.on_hand_qty })}
                      className="w-20 border border-gray-300 rounded px-1.5 py-1 text-sm text-center shrink-0"
                    />
                    <input
                      type="number" min={0} aria-label={`${r.sku} reorder point`}
                      value={r.reorder_point}
                      onChange={(e) => editLocal(r.sku, { reorder_point: toQty(e.target.value) })}
                      onBlur={() => persist(r.sku, { reorder_point: r.reorder_point })}
                      className="w-20 border border-gray-300 rounded px-1.5 py-1 text-sm text-center shrink-0"
                    />
                    <input
                      type="text" aria-label={`${r.sku} storage location`}
                      value={r.storage_location ?? ''}
                      onChange={(e) => editLocal(r.sku, { storage_location: e.target.value })}
                      onBlur={() => persist(r.sku, { storage_location: r.storage_location })}
                      placeholder="—"
                      className="w-28 border border-gray-300 rounded px-1.5 py-1 text-sm shrink-0"
                    />
                    <button
                      type="button"
                      onClick={() => remove(r.sku)}
                      className="w-14 text-xs text-gray-400 hover:text-red-600 shrink-0"
                      aria-label={`Remove ${r.sku}`}
                    >
                      Remove
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </main>
    </OperatorShell>
  );
}
