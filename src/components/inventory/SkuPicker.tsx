// src/components/inventory/SkuPicker.tsx
'use client';

// Searchable type-ahead SKU picker (#82 Slice 1b-ii, Naldo's locked choice over a
// plain <select> — the catalog is ~831 items). Shows the chosen item as a chip
// (sku + name) with warnings when the bound SKU is locked (sold-out) or no longer
// in the catalog. Click the chip to re-pick; the × clears the binding.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogItem } from '@/lib/inventory/catalog';
import { searchCatalog } from '@/lib/inventory/skuSearch';

export function SkuPicker({
  catalog,
  value,
  onChange,
  ariaLabel,
  placeholder = 'Search SKU or name…',
}: {
  catalog: CatalogItem[];
  value: string;
  onChange: (sku: string) => void;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => new Map(catalog.map((c) => [c.sku, c])), [catalog]);
  const selected = value ? byId.get(value) : undefined;
  const results = useMemo(
    () => (editing ? searchCatalog(catalog, query, 50) : []),
    [editing, query, catalog],
  );

  // Focus the search input when entering edit mode (avoids the autoFocus a11y rule).
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) {
        setEditing(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [editing]);

  const pick = (sku: string) => {
    onChange(sku);
    setQuery('');
    setEditing(false);
  };

  const showChip = value && !editing;

  return (
    <div className="relative w-72" ref={boxRef}>
      {showChip ? (
        <div className="w-full flex items-center gap-2 border border-gray-300 rounded px-2 py-1 text-sm bg-white">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="flex-1 flex items-center gap-2 min-w-0 text-left hover:opacity-80"
            aria-label={ariaLabel ? `${ariaLabel}: ${value} — change` : 'Change SKU'}
          >
            <span className="font-mono text-xs text-gray-500 shrink-0">{value}</span>
            <span className="flex-1 truncate text-gray-800" title={selected?.name ?? ''}>
              {selected ? selected.name : <span className="text-amber-600">⚠ not in catalog</span>}
            </span>
            {selected?.locked && (
              <span className="text-[10px] uppercase tracking-wide text-amber-600 shrink-0" title="Sold-out / locked">
                locked
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => pick('')}
            className="text-gray-400 hover:text-red-600 shrink-0"
            aria-label="Clear SKU"
          >
            ×
          </button>
        </div>
      ) : (
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setEditing(true)}
          placeholder={placeholder}
          aria-label={ariaLabel ?? 'SKU picker'}
          className="w-full border border-gray-300 rounded px-2 py-1 text-sm bg-white"
        />
      )}

      {editing && (
        <ul className="absolute z-20 mt-1 w-full max-h-60 overflow-auto rounded border border-gray-200 bg-white shadow-lg text-sm">
          {results.length === 0 ? (
            <li className="px-2 py-2 text-gray-400">No matches</li>
          ) : (
            results.map((item) => (
              <li key={item.sku}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(item.sku)}
                  className="w-full text-left px-2 py-1.5 hover:bg-green-50 flex items-center gap-2"
                >
                  <span className="font-mono text-xs text-gray-500 shrink-0">{item.sku}</span>
                  <span className="flex-1 truncate text-gray-800">{item.name}</span>
                  {item.locked && <span className="text-[10px] uppercase text-amber-600 shrink-0">locked</span>}
                  <span className="text-[10px] text-gray-400 shrink-0">{item.yll_category ?? item.category}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
