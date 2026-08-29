'use client';

// The review queue's client island. Accept moves money (stamps the campaign
// rate); Reject requires a reason the worker will read. Duplicate flags show
// the evidence side by side and leave the call to the human.

import { useCallback, useEffect, useState } from 'react';

import { splitDuplicateSignals } from './duplicateSignals';

type Duplicate = {
  id: string;
  status: string;
  workerName: string;
  capturedAt: string | null;
  reasons: string[];
  photoUrl: string | null;
};

type QueueItem = {
  id: string;
  kind: 'yard_sign' | 'door_hanger';
  status: 'pending' | 'resubmitted';
  workerName: string;
  campaignName: string;
  suggestedAddress: string | null;
  rejectionReason: string | null;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  capturedAt: string | null;
  photoUrl: string | null;
  duplicates: Duplicate[];
};

export default function ReviewQueue() {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  // Per-item drafts (staff lens MED): acting on one row must never wipe the
  // rejection text an admin is mid-typing on ANOTHER row.
  const [reasons, setReasons] = useState<Record<string, string>>({});
  // Which items' weak (worker-day-only) duplicate lists are expanded — the
  // photos stay one tap away rather than collapsed into an unopenable count.
  const [weakOpen, setWeakOpen] = useState<Record<string, boolean>>({});

  // Reload by bumping the tick — the effect owns every setState (the
  // ClockCard load-on-mount idiom, which the react lint rule accepts).
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/advertising/review');
        if (cancelled) return;
        if (!res.ok) {
          setError('Could not load the queue.');
          return;
        }
        const body = (await res.json()) as { queue: QueueItem[] };
        if (cancelled) return;
        setQueue(body.queue);
        setError(null);
      } catch {
        if (!cancelled) setError('Could not load the queue.');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const act = async (payload: Record<string, unknown>, id: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch('/api/admin/advertising/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? 'Action failed.');
      }
      reload();
    } catch {
      setError('Action failed. Try again.');
    } finally {
      setBusy(null);
      // Only the acted-on row's draft is cleared; other rows keep theirs.
      setRejecting((current) => (current === id ? null : current));
      setReasons((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }
  };

  if (!loaded) return <p className="text-sm text-gray-500">Loading the queue…</p>;

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="rounded-lg bg-red-50 px-4 py-2 text-sm text-red-700">{error}</p>}
      {queue.length === 0 && !error && (
        <p className="text-sm text-gray-500">Nothing waiting for review.</p>
      )}

      {queue.map((item) => (
        <section key={item.id} className="rounded-xl border border-gray-200 bg-white p-4">
          <div className="flex flex-col gap-3 sm:flex-row">
            {item.photoUrl ? (
              <a href={item.photoUrl} target="_blank" rel="noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL */}
                <img src={item.photoUrl} alt="Proof" className="h-40 w-40 rounded-lg object-cover" />
              </a>
            ) : (
              <div className="flex h-40 w-40 items-center justify-center rounded-lg bg-gray-100 text-xs text-gray-400">
                no photo
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-gray-900">{item.workerName}</span>
                <span className="text-sm text-gray-500">· {item.campaignName}</span>
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
                  {item.kind === 'yard_sign' ? 'Yard sign' : 'Door hangers'}
                </span>
                {item.status === 'resubmitted' && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
                    Resubmitted{item.rejectionReason ? ` (was: ${item.rejectionReason})` : ''}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-gray-700">{item.suggestedAddress ?? 'No address suggestion'}</p>
              {item.lat !== null && item.lng !== null && (
                <p className="text-sm">
                  <a
                    className="underline text-gray-600"
                    href={`https://www.google.com/maps?q=${item.lat},${item.lng}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {item.lat.toFixed(5)}, {item.lng.toFixed(5)}
                  </a>
                  {item.accuracyM !== null && (
                    <span className="text-gray-400"> (±{Math.round(item.accuracyM)}m)</span>
                  )}
                </p>
              )}

              {item.duplicates.length > 0 && (() => {
                // Strong signals (location or address) get photos and eyes
                // up front; worker-day-only matches collapse behind a toggle,
                // because a worker placing 30 signs a day makes every sign
                // "match" its 29 siblings and the panel would drown. The
                // toggle, not a bare count (admin lens on this PR): a
                // re-placed sign a few hundred meters away carries ONLY the
                // worker-day reason, and its photo must stay one tap from
                // the decision, never invisible.
                const { strong, weak } = splitDuplicateSignals(item.duplicates);
                const showWeak = weakOpen[item.id] === true;
                const renderDup = (d: (typeof item.duplicates)[number]) => (
                  <li key={d.id} className="flex items-center gap-2 text-sm text-amber-800">
                    {d.photoUrl && (
                      <a href={d.photoUrl} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL */}
                        <img src={d.photoUrl} alt="Duplicate candidate" className="h-10 w-10 rounded object-cover" />
                      </a>
                    )}
                    <span>
                      {d.workerName} · {d.status} · {d.reasons.join(', ')}
                    </span>
                  </li>
                );
                return (
                  <div className="mt-2 rounded-lg bg-amber-50 p-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
                      Possible duplicates, your call
                    </p>
                    {strong.length > 0 && (
                      <ul className="mt-1 flex flex-col gap-1">{strong.map(renderDup)}</ul>
                    )}
                    {weak.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setWeakOpen((w) => ({ ...w, [item.id]: !(w[item.id] === true) }))}
                        className="mt-1 text-xs text-amber-700 underline"
                      >
                        {showWeak
                          ? 'Hide the same-day list'
                          : `${weak.length} more from the same worker that day (no location or address match) — show`}
                      </button>
                    )}
                    {showWeak && weak.length > 0 && (
                      <ul className="mt-1 flex flex-col gap-1">{weak.map(renderDup)}</ul>
                    )}
                  </div>
                );
              })()}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy === item.id}
                  onClick={() => void act({ action: 'accept', placementId: item.id }, item.id)}
                  className="rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
                >
                  Accept (pays the rate)
                </button>
                {rejecting === item.id ? (
                  <span className="flex items-center gap-2">
                    <input
                      autoFocus
                      value={reasons[item.id] ?? ''}
                      onChange={(e) => setReasons((prev) => ({ ...prev, [item.id]: e.target.value }))}
                      placeholder="Why? The worker sees this."
                      className="rounded-lg border border-gray-300 px-2 py-1 text-sm"
                    />
                    <button
                      type="button"
                      disabled={busy === item.id || !(reasons[item.id] ?? '').trim()}
                      onClick={() =>
                        void act(
                          { action: 'reject', placementId: item.id, reason: (reasons[item.id] ?? '').trim() },
                          item.id,
                        )
                      }
                      className="rounded-full bg-red-600 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      onClick={() => setRejecting(null)}
                      className="text-sm text-gray-500 underline"
                    >
                      cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    disabled={busy === item.id}
                    onClick={() => setRejecting(item.id)}
                    className="rounded-full border border-gray-300 px-4 py-1.5 text-sm text-gray-700 disabled:opacity-60"
                  >
                    Reject…
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>
      ))}
    </div>
  );
}
