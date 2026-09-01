'use client';

// The header search box (Naldo, 2026-08-30).
//
// Type a customer name, a phone number, an email, a display number or a
// property address from ANY operator page and jump straight to the record.
// Four groups come back (Customers, Quotes, Jobs, Invoices), ranked by
// src/lib/search/globalSearch.ts with the live work first.
//
// Two instances of this render: one in the desktop header row, one in the
// tablet/mobile bar. They are independent, which is why every id is suffixed
// with the variant — two elements sharing an id would break the combobox's
// aria wiring on the widths where both exist in the tree.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import {
  MIN_QUERY_LEN,
  emptyResults,
  flattenResults,
  nextIndex,
  totalCount,
  type SearchHit,
  type SearchKind,
  type SearchResults,
} from '@/lib/search/globalSearch';
import {
  pushRecent,
  readRecent,
  toRecent,
  writeRecent,
  type RecentHit,
} from '@/lib/search/recentHits';

/** Long enough that a fast typist issues one request, short enough to feel live. */
const DEBOUNCE_MS = 200;

const GROUP_LABELS: Record<SearchKind, string> = {
  customer: 'Customers',
  quote: 'Quotes',
  job: 'Jobs',
  invoice: 'Invoices',
};

type Variant = 'desktop' | 'mobile';

/**
 * The key combination to print in the box. Mac keyboards use Command, so
 * showing "Ctrl K" there would name a key that does nothing. Reads the
 * platform once at render; falls back to Ctrl anywhere it cannot tell, which
 * is the right guess for the office's Windows machines.
 */
function shortcutHint(): string {
  if (typeof navigator === 'undefined') return 'Ctrl K';
  const mac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');
  return mac ? '⌘ K' : 'Ctrl K';
}

export function HeaderSearch({ variant }: { variant: Variant }) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResults>(emptyResults);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // WHICH query the rows on screen belong to. Without it, Enter pressed
  // mid-debounce acts on the PREVIOUS query's list and opens a record the
  // person is no longer looking for (premerge technical lens, 2026-08-31).
  const [resultsQuery, setResultsQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Orders the reads against each other. Same idiom as OperatorNav's task
  // counts: once two reads of one endpoint can be in flight, "did this unmount"
  // is a different question from "is this still the newest answer". A slow
  // answer for "Kri" must never overwrite a fast one for "Kristie".
  const sequenceRef = useRef(0);
  // What this browser opened from the box already, newest first. Loaded when
  // the box is FOCUSED rather than on mount: storage cannot be read during a
  // server render, this list is only ever looked at once the box is open, and
  // reading it on mount would touch storage on every page load for a list
  // nobody may open. It also keeps the read out of an effect body, which this
  // repo lints against.
  const [recent, setRecent] = useState<RecentHit[]>([]);

  const hits = useMemo(() => flattenResults(results), [results]);
  const count = totalCount(results);
  const trimmed = query.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MIN_QUERY_LEN;
  // The rows on screen do not match what is typed: a read is still in flight.
  const stale = trimmed.length >= MIN_QUERY_LEN && resultsQuery !== trimmed;

  // Clearing back below the minimum is handled HERE rather than in the effect
  // below, because a synchronous setState inside an effect body is a lint
  // error in this repo (react-hooks/set-state-in-effect) and, more to the
  // point, this is a direct consequence of the keystroke rather than a
  // synchronisation with anything external. Bumping the sequence is the load-
  // bearing half: it invalidates any read still in flight, so emptying the box
  // cannot be undone a moment later by an answer to what used to be typed.
  const onQueryChange = (value: string) => {
    setQuery(value);
    setOpen(true);
    if (value.trim().length < MIN_QUERY_LEN) {
      sequenceRef.current += 1;
      setResults(emptyResults());
      setResultsQuery(value.trim());
      setLoading(false);
      setFailed(false);
      setActiveIndex(-1);
    }
  };

  // The search itself. Debounced, and every superseded read is dropped on
  // arrival rather than cancelled, so a slow network cannot rewrite the list
  // under the person reading it.
  useEffect(() => {
    if (trimmed.length < MIN_QUERY_LEN) return;

    const sequence = ++sequenceRef.current;
    const timer = setTimeout(() => {
      setLoading(true);
      setFailed(false);
      fetch(`/api/search?q=${encodeURIComponent(trimmed)}`)
        .then((res) => (res.ok ? (res.json() as Promise<{ results?: SearchResults }>) : null))
        .then((body) => {
          if (sequence !== sequenceRef.current) return; // a newer read already won
          if (!body?.results) {
            setResults(emptyResults());
            setFailed(true);
          } else {
            setResults(body.results);
            setFailed(false);
          }
          setResultsQuery(trimmed);
          setActiveIndex(-1);
          setLoading(false);
        })
        .catch(() => {
          if (sequence !== sequenceRef.current) return;
          setResults(emptyResults());
          setResultsQuery(trimmed);
          setFailed(true);
          setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [trimmed]);

  // Close on an outside click or Escape, and open the box from anywhere with
  // Ctrl+K / Cmd+K. The shortcut is bound on the DESKTOP instance only: both
  // instances exist in the tree at every width (Tailwind hides one with CSS,
  // it is not unmounted), so binding both would race two boxes for one
  // keystroke and focus whichever listener ran last.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
      if (variant === 'desktop' && e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [variant]);

  const go = (hit: SearchHit) => {
    // Built from STORAGE, not from this component's state. The state may be
    // empty (the box was never focused, or the other instance did the last
    // write), and pushing onto an empty list would silently discard the
    // history rather than adding to it.
    const next = pushRecent(readRecent(), toRecent(hit));
    setRecent(next);
    writeRecent(next);
    setOpen(false);
    setQuery('');
    setResults(emptyResults());
    setResultsQuery('');
    setActiveIndex(-1);
    inputRef.current?.blur();
    router.push(hit.href);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setOpen(true);
      setActiveIndex((i) => nextIndex(i, e.key === 'ArrowDown' ? 1 : -1, count));
      return;
    }
    if (e.key === 'Enter') {
      // Never act on a list that belongs to an earlier query. Typing
      // "Kristie" and hitting Enter inside the debounce window would
      // otherwise open whatever the top hit for "Kris" happened to be.
      if (stale) {
        e.preventDefault();
        return;
      }
      // Enter with nothing highlighted opens the first hit, which is what the
      // ranking promised: the most relevant live record is already on top.
      const target = hits[activeIndex >= 0 ? activeIndex : 0];
      if (target) {
        e.preventDefault();
        go(target);
      }
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const listId = `header-search-results-${variant}`;
  const showPanel = open && trimmed.length > 0;
  // Nothing typed yet: offer what this person already opened rather than an
  // empty box. Only when there is something to offer, so a first-time box
  // opens as it always did instead of flashing an empty heading.
  const showRecent = open && trimmed.length === 0 && recent.length > 0;

  let flatIndex = -1;

  return (
    <div ref={rootRef} className="relative w-full">
      <label htmlFor={`header-search-${variant}`} className="sr-only">
        Search customers, quotes, jobs and invoices
      </label>
      <input
        id={`header-search-${variant}`}
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder="Search"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onFocus={() => {
          setOpen(true);
          setRecent(readRecent());
        }}
        onKeyDown={onKeyDown}
        className="w-full rounded-md border px-2 py-1 pr-11 text-sm outline-none focus:ring-1"
        style={{
          borderColor: 'var(--op-border)',
          background: 'var(--op-bg)',
          color: 'var(--op-text)',
        }}
      />
      {/* The shortcut only works on the desktop instance, so only that one
          advertises it. Hidden once anything is typed, because by then the
          person is already in the box and the hint is just clutter over their
          text. aria-hidden: it is decoration, and the input's own label
          already names the control. Nobody discovers a shortcut that is not
          shown (Naldo, 2026-09-01). */}
      {variant === 'desktop' && query === '' && (
        <span
          aria-hidden
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 select-none rounded border px-1 text-[10px] leading-[1.4]"
          style={{
            borderColor: 'var(--op-border)',
            color: 'var(--op-text-2)',
            opacity: 0.75,
          }}
        >
          {shortcutHint()}
        </span>
      )}

      {showRecent && (
        <div
          role="listbox"
          aria-label="Recently opened"
          className="absolute right-0 top-full z-50 mt-1 w-[80vw] max-w-sm max-h-[70vh] overflow-y-auto rounded-lg border shadow-lg py-1 lg:w-80 lg:left-0 lg:right-auto"
          style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
        >
          <p
            className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-widest"
            style={{ color: 'var(--op-text-2)' }}
          >
            Recently opened
          </p>
          {recent.map((hit) => (
            <button
              key={hit.key}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => {
                // Reuse the same jump path, so a recent row behaves exactly
                // like a search row: the box clears, the panel closes, and the
                // record moves back to the top of this list.
                go({
                  ...hit,
                  subtitle: null,
                  status: null,
                  active: true,
                  sortedAt: null,
                });
              }}
              className="block w-full px-3 py-1.5 text-left hover:bg-black/5"
            >
              <span className="flex items-baseline gap-1.5">
                <span className="truncate text-sm font-medium" style={{ color: 'var(--op-text)' }}>
                  {hit.title}
                </span>
                {hit.label && (
                  <span className="text-xs" style={{ color: 'var(--op-text-2)' }}>
                    {hit.label}
                  </span>
                )}
                <span className="ml-auto shrink-0 text-[10px]" style={{ color: 'var(--op-text-2)' }}>
                  {GROUP_LABELS[hit.kind].replace(/s$/, '')}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {showPanel && (
        <div
          id={listId}
          role="listbox"
          aria-label="Search results"
          // Anchored to the LEFT edge of the box on desktop, not the right.
          // The box sits near the start of the header row, so a 320px panel
          // right-aligned to a 160px input hangs off the left of the viewport:
          // measured at 1280px it started at x = -7, clipping the first
          // character of every result. Growing rightwards has room at every
          // width the row supports.
          // On a phone the input itself is only about 170px wide (it shares the
          // bar with the wordmark and the hamburger), and a 170px results
          // panel is unreadable, so the panel is sized to the viewport rather
          // than to its input. It is right-anchored there because the input
          // sits mid-bar and a left-anchored 85vw panel runs off the screen.
          className="absolute right-0 top-full z-50 mt-1 w-[80vw] max-w-sm max-h-[70vh] overflow-y-auto rounded-lg border shadow-lg py-1 lg:w-80 lg:left-0 lg:right-auto"
          style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
        >
          {tooShort && (
            <p className="px-3 py-2 text-xs" style={{ color: 'var(--op-text-2)' }}>
              Keep typing to search.
            </p>
          )}
          {!tooShort && failed && (
            <p className="px-3 py-2 text-xs" style={{ color: 'var(--op-danger)' }}>
              Search is not answering right now. Try again in a moment.
            </p>
          )}
          {!tooShort && !failed && loading && count === 0 && (
            <p className="px-3 py-2 text-xs" style={{ color: 'var(--op-text-2)' }}>
              Searching…
            </p>
          )}
          {!tooShort && !failed && !loading && count === 0 && (
            <p className="px-3 py-2 text-xs" style={{ color: 'var(--op-text-2)' }}>
              Nothing matches “{trimmed}”.
            </p>
          )}

          {/* The full customer list lost its nav tab on 2026-08-31 and had no
              door left anywhere (premerge staff lens): the search box replaced
              the tab for "I know who I want", but not for browsing everyone,
              filtering by the NCE and Neighbor tags, or scanning a list. This
              row is that door, and it renders whatever was typed, so it is
              reachable even when nothing matched. */}
          {(['customer', 'quote', 'job', 'invoice'] as SearchKind[]).map((kind) => {
            const group =
              kind === 'customer'
                ? results.customers
                : kind === 'quote'
                  ? results.quotes
                  : kind === 'job'
                    ? results.jobs
                    : results.invoices;
            if (group.length === 0) return null;
            return (
              <div key={kind}>
                <p
                  className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-widest"
                  style={{ color: 'var(--op-text-2)' }}
                >
                  {GROUP_LABELS[kind]}
                </p>
                {results.truncated[kind] && (
                  <p
                    className="px-3 pb-1 text-[10px]"
                    style={{ color: 'var(--op-text-2)' }}
                  >
                    More {GROUP_LABELS[kind].toLowerCase()} match. Type more to narrow this down.
                  </p>
                )}
                {group.map((hit) => {
                  flatIndex += 1;
                  const index = flatIndex;
                  const highlighted = index === activeIndex;
                  return (
                    <button
                      key={hit.key}
                      type="button"
                      role="option"
                      aria-selected={highlighted}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => go(hit)}
                      className="block w-full px-3 py-1.5 text-left hover:bg-black/5"
                      style={highlighted ? { background: 'rgba(0,0,0,0.05)' } : undefined}
                    >
                      <span className="flex items-baseline gap-1.5">
                        <span
                          className="truncate text-sm font-medium"
                          style={{ color: 'var(--op-text)' }}
                        >
                          {hit.title}
                        </span>
                        {hit.label && (
                          <span className="text-xs" style={{ color: 'var(--op-text-2)' }}>
                            {hit.label}
                          </span>
                        )}
                      </span>
                      <span className="flex items-baseline gap-1.5">
                        {hit.status && (
                          <span
                            className="text-[11px]"
                            style={{
                              color: hit.active ? 'var(--brand-evergreen-3)' : 'var(--op-text-2)',
                            }}
                          >
                            {hit.status}
                          </span>
                        )}
                        {hit.subtitle && (
                          <span
                            className="truncate text-[11px]"
                            style={{ color: 'var(--op-text-2)' }}
                          >
                            {hit.subtitle}
                          </span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}

          <div className="mt-1 border-t pt-1" style={{ borderColor: 'var(--op-border)' }}>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setQuery('');
                setResults(emptyResults());
                setResultsQuery('');
                setActiveIndex(-1);
                inputRef.current?.blur();
                router.push('/customers');
              }}
              className="block w-full px-3 py-1.5 text-left text-xs hover:bg-black/5"
              style={{ color: 'var(--op-text-2)' }}
            >
              Browse all customers →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
