'use client';

import { useCallback, useState } from 'react';
import type { DuplicateContactView } from '@/lib/dashboard/inbox/types';

const ON_LABEL: Record<string, string> = { ghl: 'GHL contact id', email: 'email', phone: 'phone' };

function label(c: { name: string | null; email: string | null; phone: string | null }): string {
  return c.name || c.email || c.phone || 'Unknown contact';
}
function pairKey(p: DuplicateContactView): string {
  return `${p.a.id}-${p.b.id}`;
}

export function DuplicatesList({ initialPairs }: { initialPairs: DuplicateContactView[] }) {
  const [pairs, setPairs] = useState<DuplicateContactView[]>(initialPairs);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const merge = useCallback(async (pair: DuplicateContactView, primaryId: string, secondaryId: string) => {
    const key = pairKey(pair);
    setBusyKey(key);
    setPairs((prev) => prev.filter((p) => pairKey(p) !== key)); // optimistic
    try {
      const res = await fetch('/api/dashboard/contacts/merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ primaryId, secondaryId }),
      });
      // Restore the pair if the merge was rejected, so a failure is visible
      // rather than silently vanishing.
      if (!res.ok) setPairs((prev) => [pair, ...prev]);
    } catch {
      setPairs((prev) => [pair, ...prev]);
    } finally {
      setBusyKey(null);
    }
  }, []);

  if (pairs.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--op-text-2)' }}>
        No possible duplicate contacts found. 🎉
      </p>
    );
  }

  return (
    <ul className="space-y-3">
      {pairs.map((p) => {
        const key = pairKey(p);
        return (
          <li
            key={key}
            className="rounded-lg border p-4"
            style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
          >
            <div className="text-xs mb-2" style={{ color: 'var(--op-text-2)' }}>
              Share the same {ON_LABEL[p.on] ?? p.on}
            </div>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="text-sm" style={{ color: 'var(--op-text)' }}>
                <div>
                  <strong>{label(p.a)}</strong>{' '}
                  <span style={{ color: 'var(--op-text-2)' }}>{p.a.email ?? p.a.phone ?? ''}</span>
                </div>
                <div>
                  <strong>{label(p.b)}</strong>{' '}
                  <span style={{ color: 'var(--op-text-2)' }}>{p.b.email ?? p.b.phone ?? ''}</span>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={busyKey === key}
                  onClick={() => merge(p, p.a.id, p.b.id)}
                  className="px-3 py-1.5 rounded-md text-sm font-medium disabled:opacity-50"
                  style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
                >
                  Keep {label(p.a)}
                </button>
                <button
                  type="button"
                  disabled={busyKey === key}
                  onClick={() => merge(p, p.b.id, p.a.id)}
                  className="px-3 py-1.5 rounded-md text-sm disabled:opacity-50"
                  style={{ color: 'var(--op-text-2)', border: '1px solid var(--op-border)' }}
                >
                  Keep {label(p.b)}
                </button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
