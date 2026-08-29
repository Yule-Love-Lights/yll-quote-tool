'use client';

// The admin Profile tab, repurposed as the PAY view (Simple Crew has no pay
// concept — this is ours): per-worker earned vs pending with weekly rows,
// in the replica's card language. Earned = the stamped rates (history,
// never moves); pending = an estimate at today's rates.

import { useEffect, useState } from 'react';

import { dollars, EmptyState, SC, ScreenHeader } from './ui';

type WorkerSummary = {
  workerId: string;
  displayName: string;
  total: { pendingEstimatedCents: number; acceptedEarnedCents: number };
  byWeek: Array<{ weekStart: string; pendingEstimatedCents: number; acceptedEarnedCents: number }>;
  doorHangerCount?: number;
};

export default function PayScreen() {
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/advertising/earnings');
        if (cancelled) return;
        if (!res.ok) {
          setError('Could not load pay.');
          return;
        }
        setWorkers(((await res.json()) as { workers: WorkerSummary[] }).workers);
        setError(null);
      } catch {
        if (!cancelled) setError('Could not load pay.');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-[100svh] pb-28" style={{ background: SC.bg }}>
      <ScreenHeader title="Pay" />
      <p className="-mt-2 px-5 pb-4 text-sm" style={{ color: SC.muted }}>
        Earned is settled history, the rate stamped when each photo was accepted. Pending is an
        estimate at today&apos;s rates and moves until review happens. Test workers are excluded.
      </p>

      {error && (
        <p className="mx-5 rounded-xl bg-red-50 px-4 py-3 text-sm" style={{ color: SC.danger }}>
          {error}
        </p>
      )}

      {loaded && workers.length === 0 && !error && (
        <EmptyState kind="photos" title="No pay yet" hint="Accepted photos will land here, worker by worker." />
      )}

      <div className="flex flex-col gap-4 px-4">
        {workers.map((w) => (
          <div key={w.workerId} className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex items-baseline justify-between">
              <span className="text-xl font-semibold" style={{ color: SC.text }}>
                {w.displayName}
                {(w.doorHangerCount ?? 0) > 0 && (
                  <span className="ml-2 text-sm font-normal" style={{ color: SC.muted }}>
                    {w.doorHangerCount} door hangers
                  </span>
                )}
              </span>
              <span className="text-lg font-bold" style={{ color: SC.text }}>
                {dollars(w.total.acceptedEarnedCents)}
                {w.total.pendingEstimatedCents > 0 && (
                  <span className="ml-2 text-sm font-normal" style={{ color: SC.muted }}>
                    +{dollars(w.total.pendingEstimatedCents)} pending
                  </span>
                )}
              </span>
            </div>
            {w.byWeek.length > 0 && (
              <div className="mt-3 border-t pt-2" style={{ borderColor: '#F0F2EF' }}>
                {w.byWeek.slice(-6).map((wk) => (
                  <div key={wk.weekStart} className="flex justify-between py-1 text-sm">
                    <span style={{ color: SC.muted }}>Week of {wk.weekStart}</span>
                    <span style={{ color: SC.text }}>
                      {dollars(wk.acceptedEarnedCents)}
                      {wk.pendingEstimatedCents > 0 && (
                        <span style={{ color: SC.muted }}> (+{dollars(wk.pendingEstimatedCents)} est.)</span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
