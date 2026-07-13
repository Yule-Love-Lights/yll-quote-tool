// src/app/inventory/materials/page.tsx
'use client';

// Materials-list view (#82 Slice 2d): pick a quote, see its design's projected
// per-unit materials (qty needed + on-hand) with unbound concepts flagged. The
// server does the projection (/api/inventory/materials); this page just selects a
// quote and displays the result. Per-unit only for now (roofline = Slice 2b).

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import { InventorySubNav } from '@/components/inventory/InventorySubNav';

// WT-26: permanent/bistro quotes have no per-unit design materials (this view
// projects a design Scene) — their real BOM lives inline on the admin quote
// detail page (src/app/admin/quotes/[id]/page.tsx). Point staff there instead
// of a bare "no design" dead end.
const PERMANENT_SERVICE_TYPES = new Set(['permanent', 'permanent_bistro']);

type QuoteItem = {
  id: string;
  customer_name: string | null;
  total: number | null;
  created_at: string;
  service_type: string | null;
};
type Material = { sku: string; name: string; qty: number; onHand: number | null; short: boolean };
type Unbound = { conceptKey: string; label: string; qty: number };
type MaterialsResult = { hasDesign: boolean; materials: Material[]; unbound: Unbound[]; totalLines: number };

export default function MaterialsPage() {
  const [quotes, setQuotes] = useState<QuoteItem[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<MaterialsResult | null>(null);
  const [loadingQuotes, setLoadingQuotes] = useState(true);
  const [loadingResult, setLoadingResult] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/quotes');
        if (res.ok) {
          const j = (await res.json()) as { items?: QuoteItem[] };
          if (!cancelled) setQuotes(Array.isArray(j.items) ? j.items : []);
        }
      } catch {
        // keep empty
      } finally {
        if (!cancelled) setLoadingQuotes(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const pick = async (id: string) => {
    setSelected(id);
    setResult(null);
    setLoadingResult(true);
    try {
      const res = await fetch(`/api/inventory/materials?quote=${encodeURIComponent(id)}`);
      if (res.ok) setResult((await res.json()) as MaterialsResult);
    } catch {
      // leave null → "couldn't load"
    } finally {
      setLoadingResult(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? quotes.filter((x) => (x.customer_name ?? '').toLowerCase().includes(q) || x.id.toLowerCase().includes(q))
      : quotes;
    return list.slice(0, 50);
  }, [quotes, query]);

  const selectedQuote = quotes.find((q) => q.id === selected);

  return (
    <OperatorShell active="inventory">
      <main className="max-w-4xl mx-auto">
        <InventorySubNav active="materials" />

        <div className="mb-4">
          <h1 className="text-xl font-semibold text-gray-900">Materials</h1>
          <p className="text-sm text-gray-500">
            Pick a quote to see the materials its design needs — wreaths, garland, spritzers, mini wraps. Roofline
            bulbs/wire/clips come later (Slice 2b).
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-6">
          {/* Quote selector */}
          <div>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search quotes…"
              aria-label="Search quotes"
              className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm mb-2"
            />
            <div className="border border-gray-100 rounded max-h-[60vh] overflow-auto">
              {loadingQuotes ? (
                <p className="text-sm text-gray-400 px-3 py-4">Loading quotes…</p>
              ) : filtered.length === 0 ? (
                <p className="text-sm text-gray-400 px-3 py-4">No quotes.</p>
              ) : (
                filtered.map((q) => (
                  <button
                    key={q.id}
                    type="button"
                    onClick={() => pick(q.id)}
                    className={`w-full text-left px-3 py-2 text-sm border-b border-gray-100 hover:bg-green-50 ${
                      selected === q.id ? 'bg-green-100' : ''
                    }`}
                  >
                    <span className="block truncate text-gray-800">{q.customer_name || 'Anonymous'}</span>
                    <span className="block text-[11px] text-gray-400">
                      {q.total != null
                        ? `$${q.total.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : '—'}{' '}
                      · {q.created_at?.slice(0, 10)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Materials */}
          <div>
            {!selected ? (
              <p className="text-sm text-gray-400 py-10 text-center">Pick a quote to see its materials.</p>
            ) : loadingResult ? (
              <p className="text-sm text-gray-500 py-10 text-center">Projecting materials…</p>
            ) : !result ? (
              <p className="text-sm text-red-600 py-10 text-center">Couldn&apos;t load materials.</p>
            ) : !result.hasDesign ? (
              selectedQuote && PERMANENT_SERVICE_TYPES.has(selectedQuote.service_type ?? '') ? (
                <div className="py-10 text-center">
                  <p className="text-sm text-gray-400 mb-2">
                    Permanent/bistro quotes don&apos;t use a design — their materials list is the BOM.
                  </p>
                  <Link href={`/admin/quotes/${selectedQuote.id}`} className="text-sm text-blue-700 hover:underline">
                    View the BOM on this quote ↗
                  </Link>
                </div>
              ) : (
                <p className="text-sm text-gray-400 py-10 text-center">This quote has no design.</p>
              )
            ) : result.totalLines === 0 ? (
              <p className="text-sm text-gray-400 py-10 text-center">
                No per-unit materials on this design (roofline-only — bulbs/wire/clips arrive in Slice 2b).
              </p>
            ) : (
              <>
                {selectedQuote && (
                  <h2 className="text-sm font-semibold text-gray-800 mb-2">
                    Materials for {selectedQuote.customer_name || 'Anonymous'}
                  </h2>
                )}
                {result.materials.length > 0 && (
                  <div className="border border-gray-100 rounded mb-4">
                    <div className="flex items-center gap-3 px-3 py-2 text-[11px] uppercase tracking-wide text-gray-400 border-b border-gray-100">
                      <span className="w-24 shrink-0">SKU</span>
                      <span className="flex-1">Item</span>
                      <span className="w-12 text-center shrink-0">Need</span>
                      <span className="w-16 text-center shrink-0">On hand</span>
                      <span className="w-24 shrink-0">Status</span>
                    </div>
                    {result.materials.map((m) => (
                      <div
                        key={m.sku}
                        className={`flex items-center gap-3 px-3 py-2 border-b border-gray-100 ${m.short ? 'bg-amber-50' : ''}`}
                      >
                        <span className="font-mono text-xs text-gray-500 w-24 shrink-0">{m.sku}</span>
                        <span className="flex-1 truncate text-sm text-gray-800" title={m.name}>{m.name}</span>
                        <span className="w-12 text-center text-sm text-gray-800 shrink-0">{m.qty}</span>
                        <span className="w-16 text-center text-sm text-gray-600 shrink-0">{m.onHand ?? '—'}</span>
                        <span className="w-24 text-xs shrink-0">
                          {m.onHand == null ? (
                            <span className="text-gray-400">Not tracked</span>
                          ) : m.short ? (
                            <span className="text-amber-700 font-medium">Short by {m.qty - m.onHand}</span>
                          ) : (
                            <span className="text-green-700">In stock</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {result.unbound.length > 0 && (
                  <div className="rounded border border-amber-200 bg-amber-50/40 p-3">
                    <h3 className="text-sm font-semibold text-amber-800">
                      ⚠ {result.unbound.length} concept{result.unbound.length === 1 ? '' : 's'} not bound yet
                    </h3>
                    <p className="text-xs text-gray-500 mb-2">
                      These design items have no SKU bound — set them on the Bindings tab.
                    </p>
                    <ul className="text-sm text-gray-700 space-y-0.5">
                      {result.unbound.map((u) => (
                        <li key={u.conceptKey}>
                          {u.label} <span className="text-gray-400">× {u.qty}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>
    </OperatorShell>
  );
}
