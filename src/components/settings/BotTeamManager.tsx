'use client';

// Admin CRUD for the text-ops bot roster (ledger #168). Talks to the admin-only
// /api/admin/bot-users endpoints (which re-verify the caller is an admin
// server-side). Roles: crew (reads + field capture), staff (+ CRM + money
// writes), admin (+ settings + bot administration). The env TELEGRAM_*_USERS
// lists remain a floor, so the two owners keep access even if the roster is
// emptied — this UI just manages everyone else.

import { useCallback, useEffect, useState } from 'react';
import type { BotRole } from '@/lib/integrations/botRoles';

type BotUser = {
  telegramUserId: string;
  displayName: string | null;
  role: BotRole;
  addedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

const ROLE_LABEL: Record<BotRole, string> = { crew: 'Crew', staff: 'Staff', admin: 'Admin' };
const ROLE_HINT: Record<BotRole, string> = {
  crew: 'Reads + report finished installs',
  staff: 'Crew + CRM, quotes, and money changes',
  admin: 'Everything, incl. settings + bot team',
};

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function BotTeamManager() {
  const [users, setUsers] = useState<BotUser[]>([]);
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

  const [telegramUserId, setTelegramUserId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<BotRole>('crew');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/bot-users');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setUsers(data.users ?? []);
      setLoadedOnce(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the roster');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Defer so load()'s synchronous loading-state update isn't dispatched within
    // the effect body (mirrors AccountsManager / the set-state-in-effect rule).
    queueMicrotask(load);
  }, [load]);

  const addUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const id = telegramUserId.trim();

    // Guard against the demotion trap: the POST is an upsert, so re-adding an
    // existing id would silently overwrite their role (e.g. Add-form defaulting
    // to crew would demote a staffer). Send them to the row dropdown instead.
    const existing = users.find((u) => u.telegramUserId === id);
    if (existing) {
      setNotice(null);
      setError(
        `${existing.displayName ?? id} is already on the roster as ${ROLE_LABEL[existing.role].toLowerCase()}. Change their role in the table below.`,
      );
      return;
    }

    // Promoting straight to admin from a form is the riskiest action here; make
    // it deliberate (mirrors the row-dropdown guard below).
    if (role === 'admin' && !window.confirm('Add this person as an ADMIN? They get full settings access and bot administration, not just field/CRM tools.')) {
      return;
    }

    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/admin/bot-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telegramUserId: id, displayName: displayName.trim(), role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Failed to add to the roster');
      setTelegramUserId('');
      setDisplayName('');
      setRole('crew');
      setNotice(`Added ${data.user?.displayName ?? data.user?.telegramUserId ?? 'person'} as ${ROLE_LABEL[role].toLowerCase()}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add to the roster');
    } finally {
      setAdding(false);
    }
  };

  const act = async (id: string, method: 'PATCH' | 'DELETE', body?: Record<string, unknown>) => {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/bot-users/${id}`, {
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

  const who = (u: BotUser) => u.displayName ?? u.telegramUserId;

  const changeRole = (u: BotUser, next: BotRole) => {
    if (next === u.role) return;
    // Confirm promotions TO admin only — crew↔staff moves are low-stakes.
    if (
      next === 'admin' &&
      !window.confirm(`Make ${who(u)} an admin? They'll get full settings access and bot administration, not just field/CRM tools.`)
    ) {
      return;
    }
    act(u.telegramUserId, 'PATCH', { role: next }).then((ok) => {
      if (ok) setNotice(`${who(u)} is now ${ROLE_LABEL[next].toLowerCase()}.`);
    });
  };

  const remove = (u: BotUser) => {
    if (!window.confirm(`Remove ${who(u)} from the bot? They'll no longer be able to use it.`)) return;
    act(u.telegramUserId, 'DELETE').then((ok) => {
      if (ok) setNotice(`Removed ${who(u)}.`);
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Add someone */}
      <form
        onSubmit={addUser}
        className="rounded-2xl border border-gray-200 bg-white p-5 md:p-6 flex flex-col gap-4"
      >
        <h2 className="text-[15px] font-semibold text-gray-900">Add someone to the bot</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Telegram user id</span>
            <input
              type="text"
              inputMode="numeric"
              required
              value={telegramUserId}
              onChange={(e) => setTelegramUserId(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
              placeholder="8547103546"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Name (optional)</span>
            <input
              type="text"
              maxLength={80}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              placeholder="Mike"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium text-gray-600">Role</span>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as BotRole)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
            >
              <option value="crew">Crew</option>
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
            </select>
            {/* Static, not a hover title — visible on touch, and on the form an
                admin is most likely to be unsure what a tier means. */}
            <span className="text-xs text-gray-500">{ROLE_HINT[role]}</span>
          </label>
        </div>
        <p className="text-xs text-gray-500 leading-relaxed">
          The Telegram user id is a number, not a @username, and only the exact number the bot
          sees works (a phone number won&rsquo;t). Easiest way to get it: add the person to your
          crew Telegram group, have them send <span className="font-mono">/id</span> to the bot,
          and it replies with their number.
        </p>
        <div>
          <button
            type="submit"
            disabled={adding}
            className="inline-flex items-center rounded-full bg-emerald-700 px-5 py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            {adding ? 'Adding…' : 'Add to bot'}
          </button>
        </div>
      </form>

      {/* Messages */}
      <div aria-live="polite" className="min-h-[1.25rem] text-sm">
        {error && <span className="text-red-600">{error}</span>}
        {!error && notice && <span className="text-emerald-600">{notice}</span>}
      </div>

      {/* Roster */}
      <section>
        <h2 className="text-[15px] font-semibold text-gray-900 mb-3">Bot team roster</h2>
        <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500 border-b border-gray-200">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Telegram id</th>
                <th className="px-4 py-2.5 font-medium">Role</th>
                <th className="px-4 py-2.5 font-medium">Added</th>
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
                    No one added yet.
                  </td>
                </tr>
              ) : (
                users.map((u) => {
                  const busy = busyId === u.telegramUserId;
                  return (
                    <tr key={u.telegramUserId} className="border-t border-gray-100">
                      <td className="px-4 py-2.5 text-gray-900">
                        {u.displayName ?? <span className="text-gray-400">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 font-mono text-xs">{u.telegramUserId}</td>
                      <td className="px-4 py-2.5">
                        <select
                          value={u.role}
                          disabled={busy}
                          onChange={(e) => changeRole(u, e.target.value as BotRole)}
                          title={ROLE_HINT[u.role]}
                          className="rounded-md border border-gray-300 px-2 py-1 text-xs bg-white disabled:opacity-50"
                        >
                          <option value="crew">Crew</option>
                          <option value="staff">Staff</option>
                          <option value="admin">Admin</option>
                        </select>
                      </td>
                      <td className="px-4 py-2.5 text-gray-500 text-xs">
                        {fmtDate(u.createdAt)}
                        {u.addedBy ? <span className="text-gray-400"> · {u.addedBy}</span> : null}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex justify-end">
                          <button
                            onClick={() => remove(u)}
                            disabled={busy}
                            className="rounded-md border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        {/* Persistent, not empty-state-only: the owners are admins via server
            config and never appear as rows, so say so no matter the row count. */}
        <p className="mt-3 text-xs text-gray-500 leading-relaxed">
          Naldo and Jason aren&rsquo;t listed here — they&rsquo;re admins by default from server
          config and can&rsquo;t be removed or downgraded from this page, so you can&rsquo;t lock
          the bot&rsquo;s administration out. Adding someone here sets their role; they still need
          to be in a Telegram chat the bot is allowed in before it answers them (that chat list is
          managed separately by Naldo or Jason).
        </p>
      </section>
    </div>
  );
}
