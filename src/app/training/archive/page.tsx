'use client';

// #167 P1 slice 2 — the operator's trigger for the archive imagery fetch.
//
// The Google Maps key only exists in the deployed environment, so this batch
// cannot be run from a dev checkout or a script — it runs here, on a click.
// Deliberately minimal: counters, a button, and an honest per-property result
// list. Slice 3 grows THIS page into the full review queue (grouped property
// cards with the night photos, "Trace this house" into /training/new, and a
// needs-identification lane for the rows with no address); everything here is
// meant to be built on rather than thrown away.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';

type Status = {
  properties: { total: number; withImagery: number; failed: number; pending: number };
  photos: { total: number; pending: number; readyToTrace: number; excluded: number; other: number };
  needsAddress: number;
  googleMapsConfigured: boolean;
};

type PropertyResult = {
  addressKey: string;
  address: string;
  photos: number;
  ok: boolean;
  satelliteRef?: string;
  streetViewRef?: string | null;
  error?: string;
};

type Run = {
  attempted: number;
  fetched: number;
  failed: number;
  remaining: number;
  stoppedOnDeadline: boolean;
  results: PropertyResult[];
};

export default function ArchiveImageryPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/training/archive/imagery');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load the archive queue');
      setStatus(data as Status);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the archive queue');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Match /training: defer so the loading-state update isn't dispatched
    // synchronously inside the effect. Microtasks flush before paint.
    queueMicrotask(refresh);
  }, []);

  const fetchBatch = async (retryFailed: boolean) => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/training/archive/imagery', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ retryFailed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Fetch failed');
      setRun(data as Run);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Fetch failed');
    } finally {
      setRunning(false);
      // Counters move on every run — reread them rather than deriving from the
      // run summary, so what the page shows is what the table actually holds.
      refresh();
    }
  };

  const p = status?.properties;
  const canFetch = !!status?.googleMapsConfigured && !running && (p?.pending ?? 0) > 0;

  return (
    <OperatorShell active="training">
      <div className="max-w-5xl mx-auto">
        <SettingsSubNav active="training" />

        <div className="flex justify-between items-start mb-6 gap-4 flex-wrap">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: 'var(--brand-evergreen-3)' }}>
              Yule Love Lights
            </p>
            <h1 className="text-2xl font-bold text-gray-900">Archive Review Queue</h1>
            <p className="text-sm text-gray-500 mt-1 max-w-2xl">
              Past installs from the photo archive. Each property needs its daytime satellite fetched before
              anyone can trace it — the archive photos are night shots of the finished job, useful as reference
              but not something you can measure on.
            </p>
          </div>
          <Link
            href="/training"
            className="bg-white border border-gray-300 hover:bg-gray-50 text-gray-700 font-medium text-sm px-4 py-2 rounded-md"
          >
            Training Database
          </Link>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-md p-3 text-sm text-red-700 mb-4">{error}</div>
        )}

        {loading && !status && <p className="text-sm text-gray-500">Loading…</p>}

        {status && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              <Stat label="Properties" value={p!.total} hint={`${status.photos.total} archive photos`} />
              <Stat label="Imagery ready" value={p!.withImagery} hint="ready to trace" />
              <Stat label="Awaiting fetch" value={p!.pending} hint="no satellite yet" />
              <Stat label="Needs a human" value={p!.failed + status.needsAddress} hint="bad address or no address" />
            </div>

            {!status.googleMapsConfigured && (
              <div className="bg-amber-50 border border-amber-200 rounded-md p-3 text-sm text-amber-800 mb-4">
                This environment has no Google Maps key, so imagery can&apos;t be fetched here. Run it on the
                deployed app.
              </div>
            )}

            <div className="flex gap-2 flex-wrap mb-6">
              <button
                onClick={() => fetchBatch(false)}
                disabled={!canFetch}
                className="bg-green-600 hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2 rounded-md"
              >
                {running ? 'Fetching…' : `Fetch imagery (${p!.pending} left)`}
              </button>
              {p!.failed > 0 && (
                <button
                  onClick={() => fetchBatch(true)}
                  disabled={running || !status.googleMapsConfigured}
                  className="bg-white border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed text-gray-700 font-medium text-sm px-4 py-2 rounded-md"
                >
                  Retry {p!.failed} failed
                </button>
              )}
            </div>

            {p!.pending === 0 && p!.failed === 0 && p!.total > 0 && (
              <div className="bg-green-50 border border-green-200 rounded-md p-3 text-sm text-green-800 mb-6">
                Every property has its imagery. Tracing is next.
              </div>
            )}

            {status.needsAddress > 0 && (
              <div className="bg-gray-50 border border-gray-200 rounded-md p-3 text-sm text-gray-600 mb-6">
                {status.needsAddress} archive photo{status.needsAddress === 1 ? '' : 's'} {status.needsAddress === 1 ? 'has' : 'have'} no
                address to look up — a customer link with no address typed, or a name we never found in the CRM.
                They need identifying by hand before they can be fetched.
              </div>
            )}
          </>
        )}

        {run && (
          <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-200 text-sm text-gray-700">
              <strong>{run.fetched} fetched</strong>
              {run.failed > 0 && <span className="text-red-700"> · {run.failed} failed</span>}
              {run.remaining > 0 && <span className="text-gray-500"> · {run.remaining} still to go</span>}
              {run.stoppedOnDeadline && (
                <span className="text-gray-500"> · stopped on the time limit, click again to continue</span>
              )}
            </div>
            <ul className="divide-y divide-gray-100">
              {run.results.map((r) => (
                <li key={r.addressKey} className="px-4 py-3 text-sm">
                  <div className="flex items-start gap-2">
                    <span className={r.ok ? 'text-green-600' : 'text-red-600'}>{r.ok ? '✓' : '✗'}</span>
                    <div className="min-w-0">
                      <div className="text-gray-900 break-words">{r.address}</div>
                      <div className="text-xs text-gray-500">
                        {r.photos} photo{r.photos === 1 ? '' : 's'}
                        {r.ok && r.streetViewRef == null && ' · no Street View available'}
                      </div>
                      {r.error && <div className="text-xs text-red-700 mt-1 break-words">{r.error}</div>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </OperatorShell>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-2xl font-bold text-gray-900 mt-1">{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{hint}</div>
    </div>
  );
}
