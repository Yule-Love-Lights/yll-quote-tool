'use client';

// Operator login page (ledger #81, Option B — Supabase Auth). Per-user email +
// password: posts to /api/login, which signs in against Supabase and sets the
// SSR session cookies the middleware validates. Redirects back to the page the
// operator was trying to reach.

import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

// WT-61: `from.startsWith('/')` alone lets a protocol-relative value like
// `//evil.com/x` through — the browser treats a leading `//` as "same scheme,
// different host", so `router.replace` navigates off-origin (open redirect /
// phishing). Require a single leading slash: same-origin path, not a
// scheme-relative host.
export function safeRedirectTarget(target: string): string {
  return target.startsWith('/') && !target.startsWith('//') ? target : '/';
}

function LoginForm() {
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
      router.replace(safeRedirectTarget(from));
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

export default function LoginPage() {
  return (
    <main className="flex min-h-[100svh] flex-col items-center justify-center gap-8 bg-[#0B140F] px-6 py-16 text-center">
      <h1 className="text-2xl font-semibold text-[#F4EFE6]">Yule Love Lights — Operator</h1>
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
