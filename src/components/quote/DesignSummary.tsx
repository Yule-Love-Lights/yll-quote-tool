'use client';

// "From your design" — read-only billing summary of the linked design (C3b,
// shipped with #35). With the manual per-unit form sections gone, this is how
// staff see what the design will bill BEFORE hitting Calculate: fetch the
// scene, project it (projectScene) and price it (calculateQuote) client-side —
// both are pure libs, so this never drifts from the real engine.
//
// Roofline is intentionally absent: it bills from the MEASUREMENT (satellite
// lines / typed footage), not from the design (contract §7). Custom line items
// live in their own section below.

import { useCallback, useEffect, useState } from 'react';
import { projectScene } from '@/lib/design/projectScene';
import { calculateQuote, type LineItem } from '@/lib/pricing/pricingEngine';
import type { Scene } from '@/lib/design/sceneTypes';
import { offeredFromLists, type OfferedColorLists } from '@/lib/inventory/resolveInstalls';
import { detectUnfulfillable, type UnfulfillableItem } from '@/lib/inventory/detectUnfulfillable';

const usd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

type Props = {
  designId: string;
  /** Bump to force a re-fetch (e.g. after a seed / photo change). */
  refreshKey?: number;
};

export default function DesignSummary({ designId, refreshKey = 0 }: Props) {
  const [lines, setLines] = useState<LineItem[] | null>(null);
  const [unfulfillable, setUnfulfillable] = useState<UnfulfillableItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // Load the design + the offered-colors (from bindings) together; the latter
      // drives the #92 "we can't supply this" flags.
      const [res, offRes] = await Promise.all([
        fetch(`/api/designs/${designId}`),
        fetch('/api/inventory/offered-colors'),
      ]);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Could not load the design');
      const scene: Scene = data?.design?.scene ?? { yardsticks: [], items: [] };
      const offered: OfferedColorLists | null = offRes.ok ? await offRes.json().catch(() => null) : null;
      setUnfulfillable(detectUnfulfillable(scene.items, offeredFromLists(offered)));
      const p = projectScene(scene);
      // Price ONLY the per-unit projection — zero roofline/fees — so the line
      // items here are exactly the design-driven part of the future quote.
      const result = calculateQuote({
        santasFootage: 0,
        santasDifficulty: 'medium',
        gingerbreadFootage: 0,
        gingerbreadDifficulty: 'medium',
        winterWonderlandFootage: 0,
        winterWonderlandDifficulty: 'medium',
        stakeLightingFootage: 0,
        stakeLightingDifficulty: 'medium',
        miniLightItems: p.miniLightItems,
        spritzers: p.spritzers,
        wreaths: p.wreaths,
        garland: p.garland,
        bows: p.bows,
        takedown: 'included',
        rushFee: false,
      });
      setLines(result.lineItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the design');
    } finally {
      setBusy(false);
    }
  }, [designId]);

  useEffect(() => {
    // defer so the setState inside refresh() isn't synchronous within the
    // effect body (project rule: react-hooks/set-state-in-effect at error)
    queueMicrotask(() => void refresh());
  }, [refresh, refreshKey]);

  const total = (lines ?? []).reduce((s, l) => s + l.amount, 0);

  return (
    <div className="mt-3 border border-gray-200 rounded-md p-3 bg-gray-50">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
          From your design{lines ? ` — ${lines.length} item${lines.length === 1 ? '' : 's'}` : ''}
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={busy}
          className="text-xs font-medium text-green-700 border border-green-300 hover:border-green-500 disabled:opacity-50 rounded px-2 py-1"
        >
          {busy ? 'Refreshing…' : '↻ Refresh'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {unfulfillable.length > 0 && (
        <div className="mb-2 rounded border border-red-300 bg-red-50 p-2">
          <p className="text-[11px] font-semibold text-red-700 uppercase tracking-wide mb-1">
            ⚠️ {unfulfillable.length} item{unfulfillable.length === 1 ? '' : 's'} we can&apos;t supply — fix before sending
          </p>
          <ul className="space-y-0.5">
            {unfulfillable.map((u) => (
              <li key={u.sceneItemId} className="text-xs text-red-700">
                {u.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {lines && lines.length === 0 && !error && (
        <p className="text-xs text-gray-400">
          No billable items drawn yet — minis, spritzers, wreaths, garland, and bows you place on the
          design show up here with their prices.
        </p>
      )}
      {lines && lines.length > 0 && (
        <>
          <ul className="space-y-0.5">
            {lines.map((l, i) => (
              <li key={i} className="flex justify-between text-xs text-gray-700">
                <span>{l.label}</span>
                <span className="tabular-nums">{usd(l.amount)}</span>
              </li>
            ))}
          </ul>
          <div className="flex justify-between text-xs font-semibold text-gray-800 border-t border-gray-200 mt-1.5 pt-1.5">
            <span>Design items subtotal</span>
            <span className="tabular-nums">{usd(total)}</span>
          </div>
        </>
      )}
      <p className="text-[11px] text-gray-400 mt-1.5">
        Roofline bills from the measurement (Satellite tab / typed footage), not from the drawn lines.
      </p>
    </div>
  );
}
