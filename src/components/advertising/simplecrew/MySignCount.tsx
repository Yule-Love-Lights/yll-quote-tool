'use client';

// The crew's own remaining sign count, on their Settings screen. Answers the
// question a worker would otherwise text the office, and says plainly that
// it counts what the office has RECORDED, since a hand-out nobody typed in
// makes the number low.
//
// It never blocks anything: a worker at zero still submits photos normally.
// A failed read says so rather than showing a confident zero.

import { useEffect, useState } from 'react';

import { SC } from './ui';

type Balance = { issuedTotal: number; signsUsed: number; remaining: number };

export default function MySignCount() {
  const [balance, setBalance] = useState<Balance | null>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/advertising/sign-balance');
        if (cancelled) return;
        if (!res.ok) {
          setFailed(true);
          return;
        }
        setBalance(((await res.json()) as { balance: Balance }).balance);
      } catch {
        if (!cancelled) setFailed(true);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded) return null;

  return (
    <>
      <p className="px-5 pb-2 pt-8 text-sm font-semibold uppercase tracking-wide" style={{ color: SC.muted }}>
        Your signs
      </p>
      <div className="bg-white px-5 py-4">
        {failed || !balance ? (
          <p className="text-base" style={{ color: SC.muted }}>
            Your sign count is not available right now. Everything else works as normal.
          </p>
        ) : (
          <>
            <p className="text-2xl font-bold" style={{ color: SC.text }}>
              {balance.remaining} left
            </p>
            <p className="mt-1 text-sm" style={{ color: SC.muted }}>
              {balance.issuedTotal} given to you, {balance.signsUsed} placed. This counts what the office has
              recorded, and it never stops you sending photos.
            </p>
          </>
        )}
      </div>
    </>
  );
}
