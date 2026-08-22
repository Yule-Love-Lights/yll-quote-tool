'use client';

// Customer Portal settings (Settings → Customer Portal). Business-wide toggles
// for the customer-facing quote portal, persisted via /api/settings (the global
// app_settings `portal` key). Currently: hide the Sep/Oct early-install
// discounts once that season has passed.

import { useCallback, useEffect, useState } from 'react';
import { OperatorShell } from '@/components/OperatorShell';
import { SettingsSubNav } from '@/components/dashboard/SettingsSubNav';
import { PortalSwatchEditor } from '@/components/settings/PortalSwatchEditor';

type Status = 'loading' | 'idle' | 'saving' | 'saved' | 'error';

export default function CustomerPortalSettingsPage() {
  const [hideEarlyInstall, setHideEarlyInstall] = useState(false);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/settings');
        if (!res.ok) throw new Error('Failed to load settings');
        const data = await res.json();
        if (alive) {
          setHideEarlyInstall(Boolean(data?.portal?.hideEarlyInstallDiscounts));
          setStatus('idle');
        }
      } catch {
        if (alive) {
          setError('Could not load settings');
          setStatus('error');
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const save = useCallback(async (next: boolean) => {
    setStatus('saving');
    setError(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portal: { hideEarlyInstallDiscounts: next } }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Save failed');
      }
      setStatus('saved');
      window.setTimeout(() => setStatus((s) => (s === 'saved' ? 'idle' : s)), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setStatus('error');
    }
  }, []);

  // Auto-save on toggle (single switch — no separate Save button). Optimistic;
  // reverts the checkbox if the save fails.
  const onToggle = () => {
    const next = !hideEarlyInstall;
    setHideEarlyInstall(next);
    save(next).then(() => {
      // nothing — status handled in save()
    });
  };

  return (
    <OperatorShell active="settings">
      <main className="max-w-3xl mx-auto">
        <SettingsSubNav active="customer-portal" />
        <div className="mb-6">
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: 'var(--brand-evergreen-3)' }}
          >
            Yule Love Lights
          </p>
          <h1 className="text-xl font-semibold text-gray-900">Customer Portal</h1>
          <p className="text-sm text-gray-500 mt-1">
            Settings for the customer-facing quote portal.
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6">
          <label className="flex items-start gap-4 cursor-pointer">
            <input
              type="checkbox"
              checked={hideEarlyInstall}
              onChange={onToggle}
              disabled={status === 'loading' || status === 'saving'}
              className="mt-1 h-5 w-5 shrink-0 cursor-pointer accent-emerald-700 disabled:cursor-not-allowed"
            />
            <span>
              <span className="block text-[15px] font-medium text-gray-900">
                Hide September / October early-install discounts
              </span>
              <span className="block text-sm text-gray-500 mt-1 leading-relaxed">
                Turn this on once the early-install season has passed (it&apos;s already September,
                October, or November) so customers no longer see — or get — the Sep/Oct install
                discounts on their quote portal. Applies to all quotes that aren&apos;t approved yet;
                already-approved quotes keep the price they agreed to.
              </span>
            </span>
          </label>
          <div className="mt-4 h-5 text-sm" aria-live="polite">
            {/* row 332, mirrors #171b: was a bare "Loading…" text node — the
                checkbox/label above already render unconditionally, so this
                is a small placeholder matching the status line's own visual
                weight, not a full-content skeleton. */}
            {status === 'loading' && (
              <>
                <span className="inline-block h-4 w-16 animate-pulse rounded bg-black/10" aria-hidden="true" />
                <span className="sr-only">Loading</span>
              </>
            )}
            {status === 'saving' && <span className="text-gray-400">Saving…</span>}
            {status === 'saved' && <span className="text-emerald-600">Saved</span>}
            {status === 'error' && <span className="text-red-600">{error ?? 'Something went wrong'}</span>}
          </div>
        </div>

        {/* #101 — light-color swatch editor (data-driven COLOR_SCHEMES). */}
        <PortalSwatchEditor />
      </main>
    </OperatorShell>
  );
}
