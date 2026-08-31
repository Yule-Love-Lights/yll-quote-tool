'use client';

// Sign allotments, admin view. The feature shipped fully built and tested
// with no screen calling any of it; this is its door. Hand a worker a stack
// of signs and watch the remaining count draw down as their yard-sign
// photos come in.
//
// Two things this deliberately does NOT do: it never gates a submission (a
// worker at zero still shoots, because a photo of a standing sign must not
// be refused over bookkeeping), and it never touches pay.

import { useCallback, useEffect, useState } from 'react';

import { parseAllotments, type AllotmentRow } from './signAllotmentView';
import { PrimaryButton, SC, Sheet } from './ui';

// The row shape and the parsing of the route's payload live in
// signAllotmentView.ts, where a test pins them against what the route
// actually returns.
type Balance = AllotmentRow;

type Issuance = { id: string; qty: number; note: string | null; createdAt: string };

function issuedOn(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}

export default function SignAllotmentSection() {
  const [balances, setBalances] = useState<Balance[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  const [issueFor, setIssueFor] = useState<Balance | null>(null);
  const [qty, setQty] = useState('50');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);

  const [historyFor, setHistoryFor] = useState<Balance | null>(null);
  const [history, setHistory] = useState<Issuance[] | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/admin/advertising/issuances');
        if (cancelled) return;
        if (!res.ok) {
          setError('Could not load sign allotments.');
          return;
        }
        const rows = parseAllotments(await res.json());
        if (!rows) {
          // A body we cannot read is a FAILED load, not an empty roster.
          // The first cut read the wrong key here, cleared the error state
          // and then crashed the whole Settings screen on the next line
          // (both lenses, PR #1135).
          setError('Could not load sign allotments.');
          return;
        }
        setBalances(rows);
        setError(null);
      } catch {
        if (!cancelled) setError('Could not load sign allotments.');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const issue = async () => {
    if (!issueFor) return;
    setIssueError(null);
    const trimmed = qty.trim();
    // A whole number only: Number('') is 0 and Number('5 signs') is NaN, and
    // neither should reach the server as a hand-out.
    if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
      setIssueError('Enter how many signs you handed over, as a whole number.');
      return;
    }
    const count = Number(trimmed);
    if (
      !window.confirm(
        `Give ${issueFor.displayName} ${count} signs? This also takes ${count} out of the warehouse count.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/admin/advertising/issuances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workerId: issueFor.workerId, qty: count, note: note.trim() || undefined }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setIssueError(body.error ?? 'Could not record the hand-out.');
        return;
      }
      setNotice(`${count} signs given to ${issueFor.displayName}.`);
      setIssueFor(null);
      setQty('50');
      setNote('');
      reload();
    } catch {
      setIssueError('Could not record the hand-out. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const openHistory = async (b: Balance) => {
    setHistoryFor(b);
    setHistory(null);
    setHistoryFailed(false);
    try {
      const res = await fetch(`/api/admin/advertising/issuances?workerId=${encodeURIComponent(b.workerId)}`);
      if (!res.ok) {
        setHistoryFailed(true);
        return;
      }
      const body = (await res.json()) as { issuances?: Issuance[] };
      if (!Array.isArray(body.issuances)) {
        setHistoryFailed(true);
        return;
      }
      setHistory(body.issuances);
    } catch {
      setHistoryFailed(true);
    }
  };

  return (
    <div className="pb-6">
      <p className="px-5 pb-2 pt-8 text-sm font-semibold uppercase tracking-wide" style={{ color: SC.muted }}>
        Sign allotments
      </p>
      <p className="px-5 pb-4 text-sm" style={{ color: SC.muted }}>
        Remaining is what you handed out minus the yard signs they have photographed. It is a count for the
        office, never a limit: a worker at zero can still send photos.
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

      {loaded && balances.length === 0 && !error && (
        <p className="px-5 text-sm" style={{ color: SC.muted }}>
          No crew yet. Add someone on the Crew tab and you can hand them signs here.
        </p>
      )}

      <div className="flex flex-col gap-3 px-4">
        {balances.map((b) => (
          <div key={b.workerId} className="rounded-2xl bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span
                className="text-xl font-semibold"
                style={{
                  color: b.active ? SC.text : SC.muted,
                  textDecoration: b.active ? undefined : 'line-through',
                }}
              >
                {b.displayName}
              </span>
              <span className="text-lg font-bold" style={{ color: SC.text }}>
                {b.remaining} left
              </span>
            </div>
            <p className="mt-1 text-sm" style={{ color: SC.muted }}>
              {b.issuedTotal} handed out, {b.signsUsed} placed
            </p>
            <div className="mt-3 flex flex-wrap gap-3 text-sm">
              <button
                type="button"
                className="rounded-full px-4 py-2 font-semibold text-white"
                style={{ background: SC.primaryDeep }}
                onClick={() => {
                  setQty('50');
                  setNote('');
                  setIssueError(null);
                  setIssueFor(b);
                }}
              >
                Give signs
              </button>
              <button
                type="button"
                className="rounded-full border px-4 py-2"
                style={{ borderColor: '#DCD4BE', color: SC.text }}
                onClick={() => void openHistory(b)}
              >
                History
              </button>
            </div>
          </div>
        ))}
      </div>

      <Sheet
        open={issueFor !== null}
        onClose={() => {
          // Never close over an in-flight hand-out: the sheet is the only
          // place its result is reported (staff lens MED).
          if (!busy) setIssueFor(null);
        }}
      >
        {issueFor && (
          <div style={{ color: SC.text }}>
            <h2 className="text-xl font-bold">Give signs to {issueFor.displayName}</h2>
            <p className="mt-1 text-sm" style={{ color: SC.muted }}>
              This records the hand-out and takes the same number out of the warehouse count.
            </p>
            <label className="mt-4 block text-sm" style={{ color: SC.muted }}>
              How many
              <input
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                inputMode="numeric"
                className="mt-1 w-28 rounded-xl border px-4 py-3 text-lg"
                style={{ borderColor: '#DCD4BE' }}
              />
            </label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Note (optional)"
              className="mt-3 w-full rounded-xl border px-4 py-3 text-lg"
              style={{ borderColor: '#DCD4BE' }}
            />
            {issueError && (
              <p className="mt-3 text-sm" style={{ color: SC.danger }}>
                {issueError}
              </p>
            )}
            <div className="mt-5">
              <PrimaryButton disabled={busy} onClick={() => void issue()}>
                {busy ? 'Recording…' : 'Record hand-out'}
              </PrimaryButton>
            </div>
          </div>
        )}
      </Sheet>

      <Sheet open={historyFor !== null} onClose={() => setHistoryFor(null)}>
        {historyFor && (
          <div style={{ color: SC.text }}>
            <h2 className="text-xl font-bold">{historyFor.displayName}: signs handed out</h2>
            {historyFailed && (
              <p className="mt-3 text-sm" style={{ color: SC.danger }}>
                Could not load the history. The balance on the card is still correct.
              </p>
            )}
            {history === null && !historyFailed && (
              <p className="mt-3 text-sm" style={{ color: SC.muted }}>
                Loading…
              </p>
            )}
            {history?.length === 0 && (
              <p className="mt-3 text-sm" style={{ color: SC.muted }}>
                Nothing handed out yet.
              </p>
            )}
            {history?.map((i) => (
              <div
                key={i.id}
                className="flex items-baseline justify-between border-b py-2 text-sm"
                style={{ borderColor: '#F1EBDB' }}
              >
                <span style={{ color: SC.muted }}>
                  {issuedOn(i.createdAt)}
                  {i.note ? ` · ${i.note}` : ''}
                </span>
                <span className="font-semibold" style={{ color: SC.text }}>
                  {i.qty}
                </span>
              </div>
            ))}
          </div>
        )}
      </Sheet>
    </div>
  );
}
