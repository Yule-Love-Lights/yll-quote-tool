'use client';

// Quotes settings (Settings → Quotes). Dev/testing tools for the saved-quotes
// table: make a fully-simulated TEST quote (#93) that flows the whole pipeline,
// one-click "Delete test data", and the destructive "delete all" danger zone
// (moved off /admin/quotes so it isn't in plain sight). Gated by the page + the
// #81 operator perimeter; the wipes also need a second-factor confirm header.

import { useEffect, useState } from 'react';
import Link from 'next/link';

export function QuotesSettings() {
  const [count, setCount] = useState<number | null>(null);
  // #93 — count of test quotes (is_test), shown on the "Delete test data" button.
  const [testCount, setTestCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [testBusy, setTestBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/quotes');
        const data = await res.json();
        // setState only after the await (deferred) so it isn't a synchronous
        // set-state-in-effect.
        if (!cancelled && res.ok) {
          const items = (data.items ?? []) as Array<{ is_test?: boolean }>;
          setCount(items.length);
          setTestCount(items.filter((q) => q.is_test).length);
        }
      } catch {
        /* leave counts null on failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const deleteAll = async () => {
    if (!count) return;
    if (
      !confirm(
        `Delete ALL ${count} quote${count === 1 ? '' : 's'}? This permanently wipes every saved quote and cannot be undone.`,
      )
    )
      return;
    setBusy(true);
    setMsg(null);
    try {
      // The operator session cookie rides automatically — no client-held secret.
      // The wipe still requires the explicit confirmation header (defense in depth).
      const res = await fetch('/api/quotes', {
        method: 'DELETE',
        headers: { 'x-confirm-delete-all': 'DELETE ALL QUOTES' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          window.location.href = `/login?from=${encodeURIComponent(window.location.pathname)}`;
          return;
        }
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const n = data.deleted ?? count;
      setMsg(`Deleted ${n} quote${n === 1 ? '' : 's'}.`);
      setCount(0);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const deleteTestData = async () => {
    if (!testCount) return;
    if (
      !confirm(
        `Delete ${testCount} test quote${testCount === 1 ? '' : 's'} and all their jobs/invoices? Real data is untouched. This cannot be undone.`,
      )
    )
      return;
    setTestBusy(true);
    setMsg(null);
    try {
      const res = await fetch('/api/quotes?scope=test', {
        method: 'DELETE',
        headers: { 'x-confirm-delete-all': 'DELETE TEST QUOTES' },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 401) {
          window.location.href = `/login?from=${encodeURIComponent(window.location.pathname)}`;
          return;
        }
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const n = data.deleted ?? testCount;
      setMsg(`Deleted ${n} test quote${n === 1 ? '' : 's'} (jobs + invoices cascade).`);
      setTestCount(0);
      // The wiped test rows were part of the total — keep the all-count honest.
      setCount((c) => (c == null ? c : Math.max(0, c - n)));
    } catch (err) {
      setMsg(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* #93 — Test Quote tools. A test quote flows the WHOLE pipeline (send →
          approve → simulate deposit → job → inventory) fully simulated: no real
          texts/charges, excluded from every dashboard metric, and one-click
          cleanable here. */}
      <div className="rounded-lg border border-violet-200 bg-violet-50/50 p-4">
        <h2 className="text-sm font-semibold text-violet-800">Test quotes</h2>
        <p className="text-sm text-gray-600 mt-1">
          Make a fully-simulated quote to safely exercise the whole flow without touching real data.
          It’s badged <span className="font-semibold text-violet-700">TEST</span> everywhere and excluded
          from all dashboard metrics.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link
            href="/quote/new?test=1"
            className="inline-flex items-center bg-violet-600 hover:bg-violet-700 text-white font-medium text-sm px-4 py-2 rounded-md"
          >
            + Make New Test Quote
          </Link>
          <button
            type="button"
            disabled={testBusy || !testCount}
            onClick={deleteTestData}
            className="bg-white border border-violet-300 text-violet-700 hover:bg-violet-50 disabled:opacity-50 font-medium text-sm px-4 py-2 rounded-md"
          >
            {testBusy
              ? 'Deleting…'
              : testCount
                ? `Delete test data (${testCount})`
                : 'No test data'}
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-red-200 bg-red-50/40 p-4">
        <h2 className="text-sm font-semibold text-red-800">Danger zone — delete all quotes</h2>
        <p className="text-sm text-gray-600 mt-1">
          Permanently removes <strong>every</strong> saved quote
          {count != null ? ` (${count} right now)` : ''}. Used to clear test rows while iterating.
          This cannot be undone.
        </p>
        <button
          type="button"
          disabled={busy || !count}
          onClick={deleteAll}
          className="mt-3 bg-white border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50 font-medium text-sm px-4 py-2 rounded-md"
        >
          {busy
            ? 'Deleting…'
            : count
              ? `Delete all ${count} quote${count === 1 ? '' : 's'}`
              : 'No quotes to delete'}
        </button>
        {msg && <p className="mt-2 text-sm text-gray-700">{msg}</p>}
      </div>
    </div>
  );
}
