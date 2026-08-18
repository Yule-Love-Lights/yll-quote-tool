'use client';

// Customer profile "years with YLL" editor (#178). Shows the full tenure year
// set (auto-derived ∪ manual) as chips; only the manual-only ones (no derived
// evidence backing them) carry a remove control — derived years came from a
// real paid deposit or a legacy-rebook migration row, so there's nothing to
// "remove" for them here. Saves the FULL manual_years list on every change
// (POST /api/customers/[customerId]/tenure-years), mirroring
// CustomerReferralPhotoToggle's optimistic-with-revert pattern.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function CustomerTenureEditor({
  customerId,
  derivedYears,
  initialManualYears,
}: {
  customerId: string;
  derivedYears: number[];
  initialManualYears: number[];
}) {
  const router = useRouter();
  const [manualYears, setManualYears] = useState(initialManualYears);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const derivedSet = new Set(derivedYears);
  const years = Array.from(new Set([...derivedYears, ...manualYears])).sort((a, b) => a - b);

  async function save(next: number[]) {
    const prev = manualYears;
    setManualYears(next); // optimistic
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/customers/${customerId}/tenure-years`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ manualYears: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setManualYears(prev); // revert
        setError((body as { error?: string }).error ?? 'Could not save that change.');
        return;
      }
      router.refresh();
    } catch {
      setManualYears(prev); // revert
      setError('Could not save that change.');
    } finally {
      setBusy(false);
    }
  }

  function onAdd() {
    const year = Number(input);
    const currentYear = new Date().getUTCFullYear();
    // 2022 mirrors MIN_TENURE_YEAR in src/lib/customerTenure.ts (ledger #200:
    // YLL started 2022) — kept as a literal here on purpose, not an import:
    // that module pulls in getSupabaseServiceClient (SUPABASE_SERVICE_ROLE_KEY),
    // which a 'use client' component must never bundle. Update both by hand.
    if (!Number.isInteger(year) || year < 2022 || year > currentYear) {
      setError(`Enter a year between 2022 and ${currentYear}.`);
      return;
    }
    setInput('');
    if (manualYears.includes(year) || derivedSet.has(year)) {
      setError('That year is already recorded.');
      return;
    }
    save([...manualYears, year].sort((a, b) => a - b));
  }

  function onRemove(year: number) {
    save(manualYears.filter((y) => y !== year));
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5 mb-2">
        {years.length === 0 && (
          <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>New customer</span>
        )}
        {years.map((y) => {
          const removable = manualYears.includes(y) && !derivedSet.has(y);
          return (
            <span
              key={y}
              className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded"
              style={{ background: 'var(--op-bg)', border: '1px solid var(--op-border)', color: 'var(--op-text)' }}
            >
              {y}
              {removable && (
                <button
                  type="button"
                  onClick={() => onRemove(y)}
                  disabled={busy}
                  aria-label={`Remove ${y}`}
                  className="leading-none hover:opacity-70 disabled:opacity-50"
                  style={{ color: 'var(--op-text-dim)' }}
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onAdd()}
          placeholder="Add a year"
          disabled={busy}
          className="w-28 rounded-md border px-2 py-1 text-xs"
          style={{ background: 'var(--op-bg)', borderColor: 'var(--op-border)', color: 'var(--op-text)' }}
        />
        <button
          type="button"
          onClick={onAdd}
          disabled={busy || !input}
          className="px-3 py-1 rounded-md font-medium text-xs disabled:opacity-50"
          style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
        >
          Add
        </button>
      </div>
      {error && (
        <p className="text-xs mt-1" style={{ color: '#b91c1c' }}>{error}</p>
      )}
    </div>
  );
}
