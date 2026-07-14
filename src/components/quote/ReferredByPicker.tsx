'use client';

// Referral program (#41 "mention" attribution) — a compact "Referred by"
// picker for the quote builder's Customer Info section. The referrer must be
// an EXISTING customer (our own customers table, not a HighLevel lookup — a
// referral credit only makes sense for someone who has already booked with
// us), so this searches /api/customers rather than reusing
// HighLevelContactAutocomplete. Kept intentionally thin: no keyboard
// navigation, no debounce tuning beyond the same 250ms/min-2-chars convention
// HighLevelContactAutocomplete already uses — polish can follow if this gets
// heavy use.

import { useEffect, useRef, useState } from 'react';

type CustomerHit = { id: string; name: string | null; email: string | null; phone: string | null };

export type ReferredByValue = { id: string; name: string };

type Props = {
  value: ReferredByValue | null;
  onChange: (value: ReferredByValue | null) => void;
};

export function ReferredByPicker({ value, onChange }: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CustomerHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      // Defer so these aren't synchronous setStates in the effect body
      // (mirrors HighLevelContactAutocomplete's identical guard).
      queueMicrotask(() => {
        setResults([]);
        setLoading(false);
      });
      return;
    }
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);
      try {
        const res = await fetch(`/api/customers?q=${encodeURIComponent(q)}`, { signal: ac.signal });
        const data = await res.json();
        setResults(res.ok && Array.isArray(data.customers) ? data.customers : []);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  if (value) {
    return (
      <div className="mt-4 p-2.5 bg-amber-50 border border-amber-200 rounded-md flex items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          <span className="font-medium text-amber-900">Referred by {value.name}</span>
        </div>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="shrink-0 text-amber-700 hover:text-amber-900 text-xs font-medium underline underline-offset-2"
        >
          Change
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="relative mt-4">
      <label className="block text-xs font-medium text-gray-500 mb-1">Referred by (optional)</label>
      <input
        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 placeholder:text-gray-400"
        placeholder="Search existing customers by name, email, or phone…"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        aria-autocomplete="list"
        aria-expanded={open}
        autoComplete="off"
      />
      {open && query.trim().length >= 2 && (
        <div className="absolute z-20 mt-1 left-0 right-0 bg-white border border-gray-200 rounded-md shadow-lg max-h-64 overflow-y-auto">
          {loading && (
            <div className="px-3 py-2 text-sm text-gray-500">Searching…</div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-2 text-sm text-gray-500">
              No matching customers for &ldquo;{query.trim()}&rdquo;.
            </div>
          )}
          {!loading && results.map((c) => {
            const name = c.name || '(unnamed customer)';
            const details = [c.email, c.phone].filter(Boolean).join(' · ');
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => {
                  onChange({ id: c.id, name });
                  setQuery('');
                  setResults([]);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-sm border-b border-gray-100 last:border-b-0 hover:bg-amber-50"
              >
                <div className="font-medium text-gray-900">{name}</div>
                {details && <div className="text-xs text-gray-500 mt-0.5">{details}</div>}
              </button>
            );
          })}
        </div>
      )}
      <p className="text-xs text-gray-500 mt-1">
        Stamps a referral credit to that customer once this quote books (ledger #41).
      </p>
    </div>
  );
}
