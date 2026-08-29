'use client';

// Settings → Not a lead (S75, Naldo 2026-08-29).
//
// Every time someone clicks "Not a lead" on an inbox item, that sender is added
// to a suppression list and their future messages stop notifying anyone. The
// list has been growing for months and no screen has ever shown it. This is
// that screen, plus the undo.
//
// Anything on the list that also belongs to a real customer is pulled to the
// top and flagged, because that is the case worth acting on: a booked customer
// whose emails are being silently filtered.

import { useEffect, useState } from 'react';
import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';

type Entry = {
  value: string;
  kind: 'email' | 'phone';
  suppressedAt: string | null;
  suppressedBy: string | null;
  hasQuote: boolean;
  quoteStatus: string | null;
  quoteName: string | null;
};

const MONEY_STATUSES = new Set(['approved', 'booked']);

// The audit stores whoever the auth layer resolved, which is a Supabase user id
// on a real click and the literal 'system' when the auth gate was dormant. Show
// the honest thing for each rather than dressing an id up as a name we do not
// have.
function formatActor(actor: string): string {
  return actor === 'system' ? 'an automatic rule' : `operator ${actor.slice(0, 8)}`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'Before we started recording this';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? 'Unknown'
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function SuppressedSendersPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  // Loaded once on mount. The fetch is inlined in the effect rather than
  // hoisted into a useCallback so nothing sets state synchronously before the
  // first await, which is the cascading-render the lint rule guards against.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/dashboard/suppressed-senders');
        if (!res.ok) throw new Error(`Could not load the list (${res.status})`);
        const data = await res.json();
        if (alive) setEntries(Array.isArray(data.entries) ? data.entries : []);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Could not load the list');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function unsuppress(entry: Entry) {
    const warning = entry.hasQuote
      ? `\n\nThis address belongs to ${entry.quoteName || 'a customer'} (quote status: ${entry.quoteStatus}).`
      : '';
    if (!window.confirm(`Start notifying us about ${entry.value} again?${warning}`)) return;
    setBusy(entry.value);
    setError(null);
    try {
      const res = await fetch('/api/dashboard/suppressed-senders', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: entry.value }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not remove it (${res.status})`);
      }
      setEntries((list) => list.filter((e) => e.value !== entry.value));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not remove it');
    } finally {
      setBusy(null);
    }
  }

  const needle = filter.trim().toLowerCase();
  const shown = needle
    ? entries.filter(
        (e) => e.value.includes(needle) || (e.quoteName ?? '').toLowerCase().includes(needle),
      )
    : entries;
  const flagged = entries.filter((e) => e.hasQuote && MONEY_STATUSES.has(e.quoteStatus ?? ''));

  return (
    <OperatorShell active="settings">
      <SettingsSubNav active="suppressed-senders" />
      <div className="max-w-4xl">
        <h1 className="text-xl font-semibold mb-1" style={{ color: 'var(--op-text)' }}>
          Not a lead
        </h1>
        <p className="text-sm mb-5" style={{ color: 'var(--op-text-dim)' }}>
          Every sender someone marked &ldquo;Not a lead&rdquo; in the inbox. Their messages still
          arrive, they just stop notifying anyone and get filed as automated. Remove one here to
          start hearing from them again.
        </p>

        {flagged.length > 0 && (
          <div
            className="mb-5 rounded-md border p-3 text-sm"
            style={{ borderColor: '#f0b429', background: 'rgba(240,180,41,0.08)', color: 'var(--op-text)' }}
          >
            <strong>{flagged.length}</strong> {flagged.length === 1 ? 'address is' : 'addresses are'} on
            this list even though {flagged.length === 1 ? 'it belongs' : 'they belong'} to a customer who
            approved or booked a quote. If they email us, nobody is told. They are listed first below.
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        )}

        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by address or name"
          className="mb-4 w-full rounded-md border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--op-border)', background: 'var(--op-surface)', color: 'var(--op-text)' }}
        />

        {loading ? (
          <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
            Loading the list…
          </p>
        ) : entries.length === 0 ? (
          <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
            Nobody is suppressed right now.
          </p>
        ) : (
          <>
            <p className="mb-2 text-xs" style={{ color: 'var(--op-text-dim)' }}>
              Showing {shown.length} of {entries.length}
            </p>
            <ul className="space-y-2">
              {shown.map((entry) => (
                <li
                  key={entry.value}
                  className="flex flex-wrap items-center gap-3 rounded-md border p-3"
                  style={{
                    borderColor: entry.hasQuote ? '#f0b429' : 'var(--op-border)',
                    background: 'var(--op-surface)',
                  }}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium" style={{ color: 'var(--op-text)' }}>
                      {entry.value}
                    </div>
                    <div className="text-xs" style={{ color: 'var(--op-text-dim)' }}>
                      {entry.kind === 'email' ? 'Email' : 'Phone'} · Suppressed{' '}
                      {formatWhen(entry.suppressedAt)}
                      {entry.suppressedBy && <> by {formatActor(entry.suppressedBy)}</>}
                      {entry.hasQuote && (
                        <>
                          {' '}
                          · <strong>{entry.quoteName || 'Has a quote'}</strong> ({entry.quoteStatus})
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => unsuppress(entry)}
                    disabled={busy === entry.value}
                    className="rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                    style={{ borderColor: 'var(--op-border)', color: 'var(--op-text)' }}
                  >
                    {busy === entry.value ? 'Removing…' : 'Notify us again'}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </OperatorShell>
  );
}
