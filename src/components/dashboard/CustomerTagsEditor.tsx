'use client';

// Customer profile NCE + YLL Neighbor add/remove chips (#198). Mirrors
// CustomerTenureEditor's optimistic-with-revert pattern (POST
// /api/customers/[customerId]/tags), styled with the same CSS-var convention
// as every other OperatorShell/dashboard-realm component (not the plain
// Tailwind bg-X-100 classes the admin /admin/quotes surfaces use for
// NceBadge/YllNeighborBadge — same tag, same meaning, different visual
// system per surface, matching this file's existing sibling components).
//
// Unlike quote-tag propagation (forward-only, only ever sets true), this IS
// the legitimate staff remove control — either chip toggles both ways.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const ON_STYLE = { nce: { background: '#ffe4e6', color: '#be123c' }, neighbor: { background: '#e0f2fe', color: '#0369a1' } };

export function CustomerTagsEditor({
  customerId,
  initialIsNce,
  initialIsYllNeighbor,
}: {
  customerId: string;
  initialIsNce: boolean;
  initialIsYllNeighbor: boolean;
}) {
  const router = useRouter();
  const [isNce, setIsNce] = useState(initialIsNce);
  const [isYllNeighbor, setIsYllNeighbor] = useState(initialIsYllNeighbor);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(tag: 'isNce' | 'isYllNeighbor') {
    const prevNce = isNce;
    const prevNeighbor = isYllNeighbor;
    const next = tag === 'isNce' ? !isNce : !isYllNeighbor;
    // Optimistic.
    if (tag === 'isNce') setIsNce(next);
    else setIsYllNeighbor(next);
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/customers/${customerId}/tags`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ [tag]: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setIsNce(prevNce); // revert
        setIsYllNeighbor(prevNeighbor);
        setError((body as { error?: string }).error ?? 'Could not save that change.');
        return;
      }
      router.refresh();
    } catch {
      setIsNce(prevNce); // revert
      setIsYllNeighbor(prevNeighbor);
      setError('Could not save that change.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => toggle('isYllNeighbor')}
          disabled={busy}
          aria-pressed={isYllNeighbor}
          title={isYllNeighbor ? 'YLL Neighbor — click to remove' : 'Mark as YLL Neighbor'}
          className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded disabled:opacity-50"
          style={
            isYllNeighbor
              ? ON_STYLE.neighbor
              : { background: 'var(--op-bg)', border: '1px solid var(--op-border)', color: 'var(--op-text-dim)' }
          }
        >
          YLL Neighbor
        </button>
        <button
          type="button"
          onClick={() => toggle('isNce')}
          disabled={busy}
          aria-pressed={isNce}
          title={isNce ? 'NCE — click to remove' : 'Mark as NCE (barter/trade network)'}
          className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded disabled:opacity-50"
          style={
            isNce
              ? ON_STYLE.nce
              : { background: 'var(--op-bg)', border: '1px solid var(--op-border)', color: 'var(--op-text-dim)' }
          }
        >
          NCE
        </button>
      </div>
      {error && (
        <p className="text-xs mt-1" style={{ color: '#b91c1c' }}>{error}</p>
      )}
    </div>
  );
}
