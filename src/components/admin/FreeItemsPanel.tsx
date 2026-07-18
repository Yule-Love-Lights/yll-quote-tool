'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

// Ledger #162 — staff edit the FREE ($0) items on an approved / booked order.
// A dedicated, deliberately-narrow surface: it only ever adds or removes a
// zero-dollar line, so it can never change the total (that is what the amend
// flow is for). Posts to /api/quotes/[id]/free-items and refreshes the
// server-rendered detail page on success.

type FreeItem = { id: string; label: string };

export function FreeItemsPanel({ quoteId, items }: { quoteId: string; items: FreeItem[] }) {
  const router = useRouter();
  const [label, setLabel] = useState('');
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function post(body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/quotes/${quoteId}/free-items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? 'Something went wrong');
        return false;
      }
      return true;
    } catch {
      setError('Network error, please try again');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const trimmed = label.trim();
    if (!trimmed) {
      setError('Enter an item name');
      return;
    }
    if (await post({ action: 'add', label: trimmed, quantity: qty })) {
      setLabel('');
      setQty(1);
      router.refresh();
    }
  }

  async function remove(portalId: string) {
    if (await post({ action: 'remove', portalId })) router.refresh();
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4 mb-4">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Free items</h2>
      <p className="text-xs text-gray-400 mb-3">
        Add a no-charge item to this order (for example, free spritzers the customer should have had). It
        appears on the customer portal, the PDF, and the crew materials list. The total never changes.
      </p>

      {items.length > 0 ? (
        <ul className="mb-3 space-y-1">
          {items.map((it) => (
            <li key={it.id} className="flex items-center justify-between text-sm">
              <span className="text-gray-700">
                {it.label} <span className="text-gray-400">($0)</span>
              </span>
              <button
                type="button"
                onClick={() => remove(it.id)}
                disabled={busy}
                className="text-xs text-red-600 hover:underline disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-gray-400 mb-3">No free items added.</p>
      )}

      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="block text-xs text-gray-500 mb-1">Item name</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={120}
            placeholder={'2 free 16" spritzers'}
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
          />
        </label>
        <label className="w-16">
          <span className="block text-xs text-gray-500 mb-1">Qty</span>
          <input
            type="number"
            min={1}
            max={99}
            value={qty}
            onChange={(e) => setQty(Math.max(1, Math.min(99, Number(e.target.value) || 1)))}
            className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
          />
        </label>
        <button
          type="button"
          onClick={add}
          disabled={busy || !label.trim()}
          className="bg-gray-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50"
        >
          {busy ? 'Saving…' : 'Add free item'}
        </button>
      </div>

      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
