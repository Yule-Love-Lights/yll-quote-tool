'use client';

// The PAY section, rendered inside the admin Settings screen (Naldo's
// device round, 2026-08-29: settings and pay are one place): per-worker
// earned vs pending with weekly rows, in the replica's card language.
// Earned = the stamped rates (history, never moves); pending = an estimate
// at today's rates.
//
// Settlement (ledger row 481, Naldo 2026-08-30): each worker also shows what
// has been PAID and what is still owed, and "Mark paid" records a payment
// covering everything outstanding. The confirm states the exact dollar
// amount before anything is written, and the server refuses the write if
// that number moved while this screen was open.

import { useCallback, useEffect, useState } from 'react';

import { dollars, EmptyState, PrimaryButton, SC, Sheet } from './ui';

type WorkerSummary = {
  workerId: string;
  displayName: string;
  total: { pendingEstimatedCents: number; acceptedEarnedCents: number };
  byWeek: Array<{ weekStart: string; pendingEstimatedCents: number; acceptedEarnedCents: number }>;
  doorHangerCount?: number;
};

type PayoutSummary = {
  workerId: string;
  displayName: string;
  earnedCents: number;
  settledCents: number;
  unpaidCents: number;
  lastPaidAt: string | null;
  payableCount: number;
  payableTotalCents: number;
};

const METHODS = [
  { key: 'cash', label: 'Cash' },
  { key: 'venmo', label: 'Venmo' },
  { key: 'check', label: 'Check' },
  { key: 'other', label: 'Other' },
] as const;

type MethodKey = (typeof METHODS)[number]['key'];

function paidOn(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

export default function PayScreen() {
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [payouts, setPayouts] = useState<Map<string, PayoutSummary>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [payFor, setPayFor] = useState<PayoutSummary | null>(null);
  const [method, setMethod] = useState<MethodKey>('cash');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [earningsRes, payoutsRes] = await Promise.all([
          fetch('/api/admin/advertising/earnings'),
          fetch('/api/admin/advertising/settlements'),
        ]);
        if (cancelled) return;
        if (!earningsRes.ok || !payoutsRes.ok) {
          setError('Could not load pay.');
          return;
        }
        setWorkers(((await earningsRes.json()) as { workers: WorkerSummary[] }).workers);
        const payoutList = ((await payoutsRes.json()) as { workers: PayoutSummary[] }).workers;
        setPayouts(new Map(payoutList.map((p) => [p.workerId, p])));
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
  }, [tick]);

  const submitPayment = useCallback(async () => {
    if (!payFor) return;
    setBusy(true);
    setPayError(null);
    try {
      const res = await fetch('/api/admin/advertising/settlements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workerId: payFor.workerId,
          method,
          note: note.trim() || undefined,
          // The amount this screen showed. The server pays this or nothing.
          expectedTotalCents: payFor.payableTotalCents,
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        setPayError(payload?.error ?? 'Could not record the payment.');
        return;
      }
      setNotice(`Recorded ${dollars(payFor.payableTotalCents)} paid to ${payFor.displayName}.`);
      setPayFor(null);
      setNote('');
      setMethod('cash');
      setTick((t) => t + 1);
    } catch {
      setPayError('Could not record the payment.');
    } finally {
      setBusy(false);
    }
  }, [payFor, method, note]);

  return (
    <div className="pb-6">
      <p className="px-5 pb-2 text-sm font-semibold uppercase tracking-wide" style={{ color: SC.muted }}>
        Pay
      </p>
      <p className="px-5 pb-4 text-sm" style={{ color: SC.muted }}>
        Earned is settled history, the rate stamped when each photo was accepted. Paid is what you have handed
        over; unpaid is the difference. Pending is an estimate at today&apos;s rates and moves until review
        happens. Test workers are excluded.
      </p>

      {error && (
        <p className="mx-5 rounded-xl bg-red-50 px-4 py-3 text-sm" style={{ color: SC.danger }}>
          {error}
        </p>
      )}

      {notice && (
        <p className="mx-5 mb-3 rounded-xl px-4 py-3 text-sm" style={{ background: '#EAF3E7', color: SC.text }}>
          {notice}
        </p>
      )}

      {loaded && workers.length === 0 && !error && (
        <EmptyState kind="photos" title="No pay yet" hint="Accepted photos will land here, worker by worker." />
      )}

      <div className="flex flex-col gap-4 px-4">
        {workers.map((w) => {
          const payout = payouts.get(w.workerId);
          const lastPaid = paidOn(payout?.lastPaidAt ?? null);
          return (
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

              {payout && (
                <div className="mt-3 flex gap-2">
                  {[
                    { label: 'Earned', value: payout.earnedCents },
                    { label: 'Paid', value: payout.settledCents },
                    { label: 'Unpaid', value: payout.unpaidCents },
                  ].map((cell) => (
                    <div key={cell.label} className="flex-1 rounded-xl px-3 py-2 text-center" style={{ background: '#F7F3E8' }}>
                      <p className="text-[11px] uppercase tracking-wide" style={{ color: SC.muted }}>
                        {cell.label}
                      </p>
                      <p className="text-base font-bold" style={{ color: SC.text }}>
                        {dollars(cell.value)}
                      </p>
                    </div>
                  ))}
                </div>
              )}

              {payout && (
                <div className="mt-3">
                  {payout.payableCount > 0 ? (
                    <PrimaryButton
                      onClick={() => {
                        setPayError(null);
                        setPayFor(payout);
                      }}
                    >
                      Mark paid · {dollars(payout.payableTotalCents)}
                    </PrimaryButton>
                  ) : (
                    <p className="text-sm" style={{ color: SC.muted }}>
                      Nothing outstanding{lastPaid ? ` · last paid ${lastPaid}` : ''}.
                    </p>
                  )}
                  {payout.payableCount > 0 && lastPaid && (
                    <p className="mt-2 text-center text-xs" style={{ color: SC.muted }}>
                      Last paid {lastPaid}
                    </p>
                  )}
                </div>
              )}

              {w.byWeek.length > 0 && (
                <div className="mt-3 border-t pt-2" style={{ borderColor: '#F1EBDB' }}>
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
          );
        })}
      </div>

      <Sheet open={payFor !== null} onClose={() => (busy ? undefined : setPayFor(null))}>
        {payFor && (
          <div className="flex flex-col gap-4">
            <div>
              <h2 className="text-2xl font-bold" style={{ color: SC.text }}>
                Pay {payFor.displayName} {dollars(payFor.payableTotalCents)}
              </h2>
              <p className="mt-1 text-sm" style={{ color: SC.muted }}>
                Covers {payFor.payableCount} accepted photo{payFor.payableCount === 1 ? '' : 's'} that have not
                been paid yet. This records money you have already handed over; it does not send anything.
              </p>
            </div>

            <div>
              <p className="mb-2 text-sm font-semibold" style={{ color: SC.text }}>
                How was it paid?
              </p>
              <div className="flex flex-wrap gap-2">
                {METHODS.map((m) => (
                  <button
                    key={m.key}
                    type="button"
                    onClick={() => setMethod(m.key)}
                    className="min-h-[44px] rounded-full px-4 text-base font-semibold"
                    style={{
                      background: method === m.key ? SC.primaryDeep : '#EDE6D4',
                      color: method === m.key ? '#F4EFE6' : SC.text,
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-sm font-semibold" style={{ color: SC.text }}>
                Note (optional)
              </span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Check number, which week, anything worth remembering"
                className="min-h-[48px] rounded-xl px-3 text-base"
                style={{ background: '#F7F3E8', color: SC.text }}
              />
            </label>

            {payError && (
              <p className="rounded-xl bg-red-50 px-4 py-3 text-sm" style={{ color: SC.danger }}>
                {payError}
              </p>
            )}

            <PrimaryButton onClick={submitPayment} disabled={busy}>
              {busy ? 'Recording…' : `Record ${dollars(payFor.payableTotalCents)} paid`}
            </PrimaryButton>
            <PrimaryButton tone="quiet" onClick={() => setPayFor(null)} disabled={busy}>
              Cancel
            </PrimaryButton>
          </div>
        )}
      </Sheet>
    </div>
  );
}
