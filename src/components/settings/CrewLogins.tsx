'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Settings → Accounts → Crew logins (row 279).
 *
 * Creates the SHARED login a crew member uses for both the Quote Tool and the
 * Operations Hub, and links it to their pay identity in `crew_members`.
 *
 * A crew login is NOT an operator login: it carries app_metadata.role='crew',
 * which makes getOperator() return null for it and confines it to the crew API.
 * That is why this panel is separate from the staff table above rather than a
 * third option in its role dropdown — mixing the two populations in one control
 * is how someone accidentally hands a crew member the operator surface.
 */

type CrewRow = {
  id: string;
  displayName: string;
  active: boolean;
  hasLogin: boolean;
  telegramUserId: string | null;
};

export function CrewLogins() {
  const [crew, setCrew] = useState<CrewRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [tgSelected, setTgSelected] = useState('');
  const [tgId, setTgId] = useState('');
  const [tgBusy, setTgBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Fetch inside the effect with a cancelled guard, rather than calling a
  // useCallback from the effect body: the latter trips the cascading-render
  // lint rule, and this shape also avoids setting state after unmount.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function fetchCrew() {
      try {
        const res = await fetch('/api/admin/crew-accounts');
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? 'Failed to load');
        }
        const data = (await res.json()) as { crew: CrewRow[] };
        if (!cancelled) setCrew(data.crew ?? []);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load crew members');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchCrew();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const reload = useCallback(() => {
    setLoading(true);
    setReloadToken((n) => n + 1);
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch('/api/admin/crew-accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crewMemberId: selected, email, password }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; displayName?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to create the login');
      setDone(`${data.displayName} can now sign in as ${email}.`);
      setSelected('');
      setEmail('');
      setPassword('');
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create the login');
    } finally {
      setBusy(false);
    }
  }

  async function saveTelegram(crewMemberId: string, telegramUserId: string | null) {
    setTgBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch('/api/admin/crew-accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crewMemberId, telegramUserId }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; displayName?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to save the Telegram link');
      setDone(
        telegramUserId
          ? `${data.displayName} can now clock in by texting the bot.`
          : `${data.displayName}'s Telegram is unlinked. Their texts no longer clock them in.`,
      );
      setTgSelected('');
      setTgId('');
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save the Telegram link');
    } finally {
      setTgBusy(false);
    }
  }

  const withoutLogin = crew.filter((c) => !c.hasLogin);

  return (
    <section className="mt-8 border-t border-gray-200 pt-6">
      <h2 className="text-base font-semibold text-gray-900">Crew logins</h2>
      <p className="text-sm text-gray-500 mt-1">
        One login per crew member, used for both the Quote Tool and the Operations Hub. A crew
        login reaches the crew job routes only — never customer records. It does NOT cover the
        Telegram time clock, which is a separate link set up further down this page.
      </p>

      {loading ? (
        <p className="text-sm text-gray-500 mt-4">Loading crew…</p>
      ) : (
        <>
          <ul className="mt-4 divide-y divide-gray-100 border border-gray-200 rounded-md">
            {crew.map((c) => (
              <li key={c.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="text-gray-900">
                  {c.displayName}
                  {!c.active && <span className="ml-2 text-xs text-gray-400">(inactive)</span>}
                </span>
                <span className="flex items-center gap-3">
                  <span className={c.hasLogin ? 'text-xs text-green-700' : 'text-xs text-gray-400'}>
                    {c.hasLogin ? 'Has login' : 'No login yet'}
                  </span>
                  {c.telegramUserId ? (
                    <span className="flex items-center gap-2">
                      <span className="text-xs text-green-700">Telegram linked</span>
                      <button
                        type="button"
                        disabled={tgBusy}
                        onClick={() => {
                          // Destructive and SILENT for the crew member — their
                          // texts simply stop clocking them in, with no error on
                          // their end. AccountsManager confirms before removing an
                          // account; this matches that.
                          if (
                            window.confirm(
                              `Unlink ${c.displayName}'s Telegram? Their texts will stop clocking them in until it is linked again.`,
                            )
                          ) {
                            void saveTelegram(c.id, null);
                          }
                        }}
                        className="text-xs text-gray-500 underline disabled:opacity-50"
                      >
                        Unlink
                      </button>
                    </span>
                  ) : (
                    <span className="text-xs text-amber-700">No Telegram — cannot clock in</span>
                  )}
                </span>
              </li>
            ))}
            {crew.length === 0 && (
              <li className="px-3 py-2 text-sm text-gray-500">No crew members yet.</li>
            )}
          </ul>

          {withoutLogin.length > 0 && (
            <form onSubmit={submit} className="mt-4 space-y-3">
              <div>
                <label className="block text-sm text-gray-700 mb-1" htmlFor="crew-member">
                  Crew member
                </label>
                <select
                  id="crew-member"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                  required
                >
                  <option value="">Choose…</option>
                  {withoutLogin.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm text-gray-700 mb-1" htmlFor="crew-email">
                  Email
                </label>
                <input
                  id="crew-email"
                  type="email"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div>
                <label className="block text-sm text-gray-700 mb-1" htmlFor="crew-password">
                  Temporary password
                </label>
                <input
                  id="crew-password"
                  type="password"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={8}
                  required
                />
                <p className="text-xs text-gray-500 mt-1">
                  At least 8 characters. Give it to them directly and have them change it.
                </p>
              </div>

              <button
                type="submit"
                disabled={busy}
                className="px-4 py-2 rounded-md text-sm font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: 'var(--brand-evergreen-3)' }}
              >
                {busy ? 'Creating…' : 'Create crew login'}
              </button>
            </form>
          )}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void saveTelegram(tgSelected, tgId);
            }}
            className="mt-6 space-y-3 border-t border-gray-100 pt-4"
          >
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Telegram time clock</h3>
              <p className="text-xs text-gray-500 mt-1">
                Separate from the login above — a login does not cover texting. The bot
                recognises a crew member by their Telegram account, so until this is linked their
                &quot;in&quot; and &quot;out&quot; texts do nothing at all. They can get their id
                by messaging @userinfobot.
              </p>
              <p className="text-xs text-gray-500 mt-2">
                Linking is necessary but not sufficient: the bot only reads chats on its allow
                list. Once linked they can clock in from a crew group the bot is already in. A
                one-to-one chat with the bot also needs that same id added to
                TELEGRAM_ALLOWED_CHATS, or their texts are silently ignored.
              </p>
            </div>

            <div>
              <label className="block text-sm text-gray-700 mb-1" htmlFor="tg-crew-member">
                Crew member
              </label>
              <select
                id="tg-crew-member"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={tgSelected}
                onChange={(e) => setTgSelected(e.target.value)}
                required
              >
                <option value="">Choose…</option>
                {crew.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                    {c.telegramUserId ? ' (re-link)' : ''}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm text-gray-700 mb-1" htmlFor="tg-user-id">
                Telegram user id
              </label>
              <input
                id="tg-user-id"
                inputMode="numeric"
                pattern="\d*"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={tgId}
                onChange={(e) => setTgId(e.target.value)}
                placeholder="e.g. 123456789"
                required
              />
              <p className="text-xs text-gray-500 mt-1">
                Digits only — an @handle will not work, because Telegram sends the number.
              </p>
            </div>

            <button
              type="submit"
              disabled={tgBusy}
              className="px-4 py-2 rounded-md text-sm font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: 'var(--brand-evergreen-3)' }}
            >
              {tgBusy ? 'Saving…' : 'Link Telegram'}
            </button>
          </form>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          {done && <p className="mt-3 text-sm text-green-700">{done}</p>}
        </>
      )}
    </section>
  );
}
