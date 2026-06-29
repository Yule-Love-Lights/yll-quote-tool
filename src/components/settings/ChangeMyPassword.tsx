'use client';

// Self-service "change my password" for any logged-in operator (ledger #81
// Slice 3). Posts to /api/account/password, which updates the caller's OWN
// Supabase session password — never anyone else's. Shown to every operator on
// /settings/accounts (the staff-management table below it stays admin-only).

import { useState } from 'react';

export function ChangeMyPassword({ name, email }: { name: string | null; email: string | null }) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (pw.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (pw !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setStatus('saving');
    try {
      const res = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Could not update password');
      setPw('');
      setConfirm('');
      setStatus('saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update password');
      setStatus('idle');
    }
  };

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6 flex flex-col gap-4"
    >
      <div>
        <h2 className="text-[15px] font-semibold text-gray-900">Your password</h2>
        {(name || email) && (
          <p className="text-sm text-gray-500 mt-0.5">Signed in as {name ?? email}</p>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-600">New password (≥ 8 chars)</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={pw}
            onChange={(e) => {
              setPw(e.target.value);
              setStatus('idle');
            }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-gray-600">Confirm new password</span>
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setStatus('idle');
            }}
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </label>
      </div>
      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="submit"
          disabled={status === 'saving'}
          className="inline-flex items-center rounded-full bg-emerald-700 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
        >
          {status === 'saving' ? 'Updating…' : 'Update password'}
        </button>
        <span aria-live="polite" className="text-sm">
          {status === 'saved' && <span className="text-emerald-600">Password updated.</span>}
          {error && <span className="text-red-600">{error}</span>}
        </span>
      </div>
    </form>
  );
}
