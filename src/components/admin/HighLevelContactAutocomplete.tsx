'use client';

// HighLevel contact autocomplete. Operator types a name / email / phone /
// partial match; we query GHL via our own /api/integrations/highlevel/contacts
// proxy (which adds auth + rate limiting); results drop down as a list.
// Picking one fires onPick with the full CrmContact so the parent form can
// pre-fill customer fields AND remember the HL contact id for later attach.
//
// Design notes:
// - Debounced 250ms. GHL rate-limits aggressively; we also have a 30-req/min
//   guard on the proxy endpoint.
// - Min query length 2 — single-char searches are too noisy and often error.
// - "Skip, enter manually" escape hatch: the parent form still renders the
//   4 fields below this component, so the operator can always bypass.

import { useEffect, useRef, useState } from 'react';
import type { CrmContact } from '@/lib/integrations/types';

type Props = {
  onPick: (contact: CrmContact) => void;
  placeholder?: string;
  /** Optional pre-selected contact — shown as a "chip" with an X to clear. */
  selected?: CrmContact | null;
  /** Called when user clicks the X on the chip. */
  onClear?: () => void;
};

export default function HighLevelContactAutocomplete({
  onPick,
  placeholder = 'Search HighLevel contacts by name, email, or phone…',
  selected,
  onClear,
}: Props) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CrmContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Debounced fetch. Cancel any in-flight request on keystroke to avoid
  // a race where an old search overwrites the current query's results.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      // defer the reset so these aren't synchronous setStates in the effect body
      queueMicrotask(() => {
        setResults([]);
        setError(null);
        setLoading(false);
      });
      return;
    }
    const timer = setTimeout(async () => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `/api/integrations/highlevel/contacts?q=${encodeURIComponent(q)}&limit=10`,
          { signal: ac.signal },
        );
        const data = await res.json();
        if (!res.ok) throw new Error(data.error ?? `Search failed (${res.status})`);
        setResults(Array.isArray(data.contacts) ? data.contacts : []);
        setActiveIdx(-1);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        setResults([]);
        setError(err instanceof Error ? err.message : 'Search failed');
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  // Click outside closes the dropdown.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function handlePick(c: CrmContact) {
    onPick(c);
    setQuery('');
    setResults([]);
    setOpen(false);
    setActiveIdx(-1);
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIdx >= 0) {
      e.preventDefault();
      handlePick(results[activeIdx]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  // ─── Selected state: show a chip instead of the search box ────────────
  if (selected) {
    return (
      <div className="mb-3 p-2.5 bg-green-50 border border-green-200 rounded-md flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm">
            <svg aria-hidden className="w-4 h-4 text-green-700 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="8" r="4" />
              <path d="M4 21c0-4 4-7 8-7s8 3 8 7" />
            </svg>
            <span className="font-medium text-green-900 truncate">
              {selected.fullName || [selected.firstName, selected.lastName].filter(Boolean).join(' ') || '(unnamed contact)'}
            </span>
            <span className="text-xs text-green-700 shrink-0">· HighLevel</span>
          </div>
          <div className="text-xs text-green-800/80 mt-0.5 truncate">
            {[selected.email, selected.phone, selected.address1].filter(Boolean).join(' · ') || 'No contact details on file'}
          </div>
        </div>
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            className="shrink-0 text-green-700 hover:text-green-900 text-xs font-medium underline underline-offset-2"
          >
            Change
          </button>
        )}
      </div>
    );
  }

  // ─── Default state: search input + dropdown ───────────────────────────
  return (
    <div ref={containerRef} className="relative mb-3">
      <input
        className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 placeholder:text-gray-400"
        placeholder={placeholder}
        value={query}
        onChange={e => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKey}
        aria-autocomplete="list"
        aria-expanded={open}
        autoComplete="off"
      />

      {open && (query.trim().length >= 2) && (
        <div className="absolute z-20 mt-1 left-0 right-0 bg-white border border-gray-200 rounded-md shadow-lg max-h-80 overflow-y-auto">
          {loading && (
            <div className="px-3 py-2 text-sm text-gray-500 flex items-center gap-2">
              <span className="inline-block h-2 w-2 rounded-full bg-green-500 animate-pulse" />
              Searching HighLevel…
            </div>
          )}

          {!loading && error && (
            <div className="px-3 py-2 text-sm text-red-600">{error}</div>
          )}

          {!loading && !error && results.length === 0 && (
            <div className="px-3 py-2 text-sm text-gray-500">
              No matches for &ldquo;{query.trim()}&rdquo;. Fill out the fields below to enter manually.
            </div>
          )}

          {!loading && !error && results.map((c, i) => {
            const name = c.fullName || [c.firstName, c.lastName].filter(Boolean).join(' ') || '(unnamed)';
            const details = [c.email, c.phone].filter(Boolean).join(' · ');
            const addr = [c.address1, c.city, c.state, c.postalCode].filter(Boolean).join(', ');
            const active = i === activeIdx;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => handlePick(c)}
                onMouseEnter={() => setActiveIdx(i)}
                className={`w-full text-left px-3 py-2 text-sm border-b border-gray-100 last:border-b-0 ${active ? 'bg-green-50' : 'hover:bg-gray-50'}`}
              >
                <div className="font-medium text-gray-900">{name}</div>
                {details && <div className="text-xs text-gray-500 mt-0.5">{details}</div>}
                {addr && <div className="text-xs text-gray-400 mt-0.5 truncate">{addr}</div>}
              </button>
            );
          })}
        </div>
      )}

      <p className="text-xs text-gray-500 mt-1">
        Pick a HighLevel contact to auto-fill the fields below, or just start typing in the fields to enter manually.
      </p>
    </div>
  );
}
