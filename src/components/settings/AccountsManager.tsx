'use client';

// Admin CRUD for operator accounts (ledger #81 Slice 3). Talks to the admin-only
// /api/admin/users endpoints (which re-verify the caller is an admin server-side
// and enforce the self/last-admin guards — this UI just hides the actions that
// would be rejected). Self-row actions (delete, role change) are disabled.

import { useCallback, useEffect, useState } from 'react';

type Role = 'admin' | 'operator';
type Account = {
  id: string;
  email: string | null;
  role: Role;
  name: string | null;
  createdAt: string | null;
  lastSignInAt: string | null;
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function AccountsManager({ currentUserId }: { currentUserId: string }) {
  const [users, setUsers] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // Row 346 fix round: load() also re-runs after every add/edit/delete (see
  // addUser/act below), each of which already has its OWN busy cue (the
  // `adding`/`busy` disabled-button states on the form + row buttons). Gate
  // the skeleton to the FIRST load only so those actions don't also blank
  // the whole table out from under an already-correct busy indicator —
  // set once, on the first successful load, never reset.
  const [loadedOnce, setLoadedOnce] = useState(false);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('operator');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/users');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setUsers(data.users ?? []);
      setLoadedOnce(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load accounts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer in a microtask so load()'s synchronous loading-state update isn't
    // dispatched within the effect body (microtasks flush before paint).
    queueMicrotask(load);
  }, [load]);

  const addUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), email: email.trim(), password, role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Failed to add account');
      setName('');
      setEmail('');
      setPassword('');
      setRole('operator');
      setNotice(`Added ${data.user?.name ?? data.user?.email ?? 'account'}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add account');
    } finally {
      setAdding(false);
    }
  };

  const act = async (id: string, method: 'PATCH' | 'DELETE', body?: Record<string, unknown>) => {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Action failed');
      await load();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
      return false;
    } finally {
      setBusyId(null);
    }
  };

  // Display label for an account in prompts/notices — name first, email fallback.
  const who = (u: Account) => u.name ?? u.email ?? 'this account';

  const resetPassword = (u: Account) => {
    const pw = window.prompt(`New password for ${who(u)}? (at least 8 characters)`);
    if (pw == null) return;
    if (pw.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    act(u.id, 'PATCH', { password: pw }).then((ok) => {
      if (ok) setNotice(`Password reset for ${who(u)}.`);
    });
  };

  // Set or backfill a display name (legacy accounts created before names existed).
  const editName = (u: Account) => {
    const next = window.prompt(`Display name for ${who(u)}?`, u.name ?? '');
    if (next == null) return;
    if (!next.trim()) {
      setError('A name is required');
      return;
    }
    act(u.id, 'PATCH', { name: next.trim() }).then((ok) => {
      if (ok) setNotice(`Name updated for ${next.trim()}.`);
    });
  };

  const toggleRole = (u: Account) => {
    const next: Role = u.role === 'admin' ? 'operator' : 'admin';
    act(u.id, 'PATCH', { role: next });
  };

  const remove = (u: Account) => {
    if (!window.confirm(`Remove ${who(u)}? They will no longer be able to sign in.`)) return;
    act(u.id, 'DELETE');
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Add account */}
      <form
        onSubmit={addUser}
        className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6 flex flex-col gap-4"
      >
        <h2 className="text-[15px] font-semibold text-gray-900">Add an operator</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Name</span>
            <input
              type="text"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              placeholder="Jane Smith"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Email</span>
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              placeholder="name@yulelovelights.com"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Temporary password (≥ 8 chars)</span>
            <input
              type="text"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
              placeholder="they can keep or you can reset it"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
            >
              <option value="operator">Operator</option>
              <option value="admin">Admin (can manage accounts)</option>
            </select>
          </label>
        </div>
        <div>
          <button
            type="submit"
            disabled={adding}
            className="inline-flex items-center rounded-full bg-emerald-700 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {adding ? 'Adding…' : 'Add operator'}
          </button>
        </div>
      </form>

      {/* Messages */}
      <div aria-live="polite" className="min-h-[1.25rem] text-sm">
        {error && <span className="text-red-600">{error}</span>}
        {!error && notice && <span className="text-emerald-600">{notice}</span>}
      </div>

      {/* Account list */}
      <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
              <th className="px-4 py-2.5 font-medium">Name</th>
              <th className="px-4 py-2.5 font-medium">Email</th>
              <th className="px-4 py-2.5 font-medium">Role</th>
              <th className="px-4 py-2.5 font-medium">Last sign-in</th>
              <th className="px-4 py-2.5 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && !loadedOnce ? (
              // row 346, mirrors row 332/#171b: was a bare "Loading…" cell on
              // FIRST load — placeholder rows matching this table's own row
              // height so there's no morph from empty text into real rows.
              // Gated to first load only (see loadedOnce above) — a fix-round
              // lens caught the earlier version of this also firing after
              // every add/edit/delete, blanking an already-good table under
              // an action that already has its own busy cue.
              <>
                {[0, 1, 2].map((i) => (
                  <tr key={i} className="border-t border-gray-100">
                    <td colSpan={5} className="px-4 py-2.5">
                      <div role={i === 0 ? 'status' : undefined} aria-busy={i === 0 ? true : undefined} className="h-5 animate-pulse rounded bg-black/10" />
                    </td>
                  </tr>
                ))}
              </>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-gray-400">
                  No accounts yet.
                </td>
              </tr>
            ) : (
              users.map((u) => {
                const isSelf = u.id === currentUserId;
                const busy = busyId === u.id;
                return (
                  <tr key={u.id} className="border-t border-gray-100">
                    <td className="px-4 py-2.5 text-gray-900">
                      {u.name ?? <span className="text-gray-400">—</span>}
                      {isSelf && <span className="ml-2 text-xs text-gray-400">(you)</span>}
                    </td>
                    <td className="px-4 py-2.5 text-gray-500">{u.email ?? '—'}</td>
                    <td className="px-4 py-2.5">
                      <span
                        className={
                          u.role === 'admin'
                            ? 'inline-flex rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700'
                            : 'inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600'
                        }
                      >
                        {u.role}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-500">{fmtDate(u.lastSignInAt)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex justify-end gap-2 flex-wrap">
                        <button
                          onClick={() => editName(u)}
                          disabled={busy}
                          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          Edit name
                        </button>
                        <button
                          onClick={() => resetPassword(u)}
                          disabled={busy}
                          className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                        >
                          Reset password
                        </button>
                        {!isSelf && (
                          <>
                            <button
                              onClick={() => toggleRole(u)}
                              disabled={busy}
                              className="rounded-md border border-gray-300 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                            >
                              {u.role === 'admin' ? 'Make operator' : 'Make admin'}
                            </button>
                            <button
                              onClick={() => remove(u)}
                              disabled={busy}
                              className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
