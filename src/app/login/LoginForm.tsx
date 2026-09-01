'use client';

// The login form, carved out of page.tsx unchanged when that page became a
// server component. It had to move because a page needs generateMetadata to
// give the advertising app its own home-screen identity, and a 'use client'
// module cannot export that.
//
// Operator login (ledger #81, Option B — Supabase Auth). Per-user email +
// password: posts to /api/login, which signs in against Supabase and sets the
// SSR session cookies the middleware validates. Redirects back to the page the
// operator was trying to reach.

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { safeRedirectTarget } from './redirectTarget';

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get('from') || '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? 'Login failed');
      }
      // The server names a `home` for populations confined to their own
      // surface (advertising -> /advertising); it wins over ?from=, which
      // for them would only bounce off the proxy back to this page.
      const body = (await res.json().catch(() => ({}))) as { home?: string };
      router.replace(safeRedirectTarget(typeof body.home === 'string' ? body.home : from));
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex w-full max-w-sm flex-col gap-4 text-left">
      <label htmlFor="email" className="text-sm font-medium text-[#C9D3CB]">
        Email
      </label>
      <input
        id="email"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="min-h-[48px] rounded-lg border border-white/15 bg-white/5 px-4 text-base text-white outline-none focus:border-[#E8B862]"
        required
      />
      <label htmlFor="password" className="text-sm font-medium text-[#C9D3CB]">
        Password
      </label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="min-h-[48px] rounded-lg border border-white/15 bg-white/5 px-4 text-base text-white outline-none focus:border-[#E8B862]"
        required
      />
      {error && <p className="text-sm text-[#E5736F]">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="inline-flex min-h-[48px] items-center justify-center rounded-full bg-[#E8B862] px-6 text-base font-semibold text-[#0B140F] disabled:opacity-60"
      >
        {busy ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
