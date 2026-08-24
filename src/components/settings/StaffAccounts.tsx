'use client';

import { useEffect, useState } from 'react';

import { dollarsToCents } from '@/lib/hourlyRate';
import { isValidTelegramUserId } from '@/lib/telegramUserId';

/**
 * Settings → Accounts → Staff (ledger #354, unified 2026-08-24).
 *
 * ONE list of every staff member, office and field. Naldo's ruling after driving
 * the two old panels: they did the same job in two different shapes, so
 * "everything needs to be exactly the same to make it easier to understand".
 *
 * Every row gets the same four actions — Edit rate, Link/Unlink Telegram, Reset
 * password, Activate/Deactivate — and the office/field difference is a LABEL,
 * not a different screen. The only place the two genuinely differ is adding
 * someone, because office staff link an existing operator login while field crew
 * get a new crew login created, and that is a permission boundary rather than a
 * presentation choice.
 */

type StaffRow = {
  id: string;
  displayName: string;
  active: boolean;
  isOffice: boolean;
  baseRateCents: number;
  telegramUserId: string | null;
  hasLogin: boolean;
  email: string | null;
  loginMissing: boolean;
};

type EligibleOperator = { id: string; name: string | null; email: string | null };

function fmtUsd(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function StaffAccounts() {
  const [staff, setStaff] = useState<StaffRow[]>([]);
  const [eligible, setEligible] = useState<EligibleOperator[]>([]);
  const [loading, setLoading] = useState(true);

  const [type, setType] = useState<'office' | 'field'>('office');
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Fetch inside the effect with a cancelled guard (the repo's pattern) so the
  // set-state-in-effect lint rule stays green and nothing sets state after
  // unmount.
  useEffect(() => {
    let cancelled = false;

    async function fetchStaff() {
      try {
        const res = await fetch('/api/admin/staff');
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(b.error ?? 'Failed to load');
        }
        const data = (await res.json()) as { staff: StaffRow[]; eligibleOperators: EligibleOperator[] };
        if (!cancelled) {
          setStaff(data.staff ?? []);
          setEligible(data.eligibleOperators ?? []);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load staff');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchStaff();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  function reload() {
    setLoading(true);
    setReloadToken((n) => n + 1);
  }

  /** One helper for every row action, so all four behave identically. */
  async function patchRow(row: StaffRow, payload: Record<string, unknown>, success: string) {
    setRowBusyId(row.id);
    setError(null);
    setDone(null);
    try {
      const res = await fetch('/api/admin/staff', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crewMemberId: row.id, ...payload }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'That did not work');
      setDone(success);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setRowBusyId(null);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const cents = dollarsToCents(rate);
    if (cents === null) {
      setError('Enter a valid hourly rate, for example 22.50.');
      return;
    }
    const op = eligible.find((o) => o.id === selected);
    const who = type === 'office' ? name.trim() || op?.name || op?.email || 'this operator' : name.trim();
    if (!window.confirm(`Add ${who} at ${fmtUsd(cents)} per hour?`)) return;

    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch('/api/admin/staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          type === 'office'
            ? { type, authUserId: selected, hourlyRate: rate, displayName: name }
            : { type, displayName: name, email, password, hourlyRate: rate },
        ),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; member?: { displayName?: string } };
      if (!res.ok) throw new Error(data.error ?? 'Failed to add the staff member');
      setDone(`${data.member?.displayName ?? who} was added.`);
      setSelected('');
      setName('');
      setEmail('');
      setPassword('');
      setRate('');
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to add the staff member');
    } finally {
      setBusy(false);
    }
  }

  function editRate(row: StaffRow) {
    const input = window.prompt(
      `New hourly rate for ${row.displayName}? Currently ${fmtUsd(row.baseRateCents)} per hour.`,
      (row.baseRateCents / 100).toFixed(2),
    );
    if (input == null) return;
    const cents = dollarsToCents(input);
    if (cents === null) {
      setError('Enter a valid hourly rate, for example 22.50.');
      return;
    }
    if (!window.confirm(`Set ${row.displayName}'s rate to ${fmtUsd(cents)} per hour?`)) return;
    void patchRow(row, { hourlyRate: input }, `${row.displayName}'s rate is now ${fmtUsd(cents)} per hour.`);
  }

  function editTelegram(row: StaffRow) {
    const input = window.prompt(
      `Telegram user id for ${row.displayName}? Digits only — they can get theirs by messaging @userinfobot.`,
      row.telegramUserId ?? '',
    );
    if (input == null) return;
    const trimmed = input.trim();
    if (!isValidTelegramUserId(trimmed)) {
      setError('That is not a Telegram user id. It is a number, not an @handle.');
      return;
    }
    void patchRow(row, { telegramUserId: trimmed }, `${row.displayName} can now clock in by texting the bot.`);
  }

  function unlinkTelegram(row: StaffRow) {
    // Destructive and SILENT for the staff member: their texts simply stop
    // clocking them in, with no error on their end.
    if (
      !window.confirm(
        `Unlink ${row.displayName}'s Telegram? Their texts will stop clocking them in until it is linked again.`,
      )
    ) {
      return;
    }
    void patchRow(row, { telegramUserId: null }, `${row.displayName}'s Telegram is unlinked.`);
  }

  function resetPassword(row: StaffRow) {
    const input = window.prompt(`New password for ${row.displayName}? At least 8 characters.`);
    if (input == null) return;
    if (input.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    void patchRow(row, { password: input }, `${row.displayName}'s password was reset. Give it to them directly.`);
  }

  function toggleActive(row: StaffRow) {
    if (
      row.active &&
      !window.confirm(
        `Deactivate ${row.displayName}? They will not be able to clock in until you activate them again.`,
      )
    ) {
      return;
    }
    void patchRow(
      row,
      { active: !row.active },
      row.active
        ? `${row.displayName} is deactivated. Their clock is off until reactivated.`
        : `${row.displayName} is active again and can clock in.`,
    );
  }

  const operatorLabel = (o: EligibleOperator) => o.name ?? o.email ?? 'Unnamed operator';
  const action = 'text-xs text-gray-500 underline disabled:opacity-50';

  // Grouped for readability, NOT split back into two panels: same row shape and
  // the same five actions in both groups, so there is still only one thing to
  // learn. The office/field difference is who they sign in as, which is what the
  // group heading says.
  //
  // The hints describe what the office/field flag ACTUALLY controls, which is
  // only one thing: whether someone is offered as assignable crew when
  // scheduling a job. It does NOT decide how they clock in, and it does NOT
  // follow from what kind of login they hold — an admin can sit in either group
  // (Jason does), and both groups can use both clocks. Saying "field crew sign
  // in with a crew login" was wrong the moment a real row disproved it.
  const groups = [
    {
      label: 'Office',
      hint: 'Not offered when assigning crew to a job. Clocks in the same ways as everyone else.',
      rows: staff.filter((s) => s.isOffice),
    },
    {
      label: 'Field crew',
      hint: 'Offered when assigning crew to a job. Clocks in the same ways as everyone else.',
      rows: staff.filter((s) => !s.isOffice),
    },
  ];

  return (
    <section className="mt-8 border-t border-gray-200 pt-6">
      <h2 className="text-base font-semibold text-gray-900">Staff</h2>
      <p className="text-sm text-gray-500 mt-1">
        Everyone who clocks in. Anyone here can clock in from the dashboard header, or by texting
        the bot once their Telegram is linked. The only difference between the two groups below is
        whether they are offered when you assign crew to a job.
      </p>
      <p className="text-xs text-gray-500 mt-2">
        Linking Telegram is necessary but not enough on its own: the bot only reads chats on its
        allow list, so texting works in a group the bot is already in, while a one-to-one chat also
        needs that same id added to TELEGRAM_ALLOWED_CHATS. Until then their texts are ignored
        silently, with no error shown to them.
      </p>

      {loading ? (
        <p className="text-sm text-gray-500 mt-4">Loading staff…</p>
      ) : (
        <>
          {groups.map(({ label, rows, hint }) => (
            <div key={label} className="mt-4">
              <h3 className="text-sm font-semibold text-gray-900">{label}</h3>
              <p className="text-xs text-gray-500 mb-2">{hint}</p>
              <ul className="divide-y divide-gray-100 border border-gray-200 rounded-md">
                {rows.map((s) => (
                  <li key={s.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0 truncate">
                      <span className="text-gray-900">{s.displayName}</span>
                      {s.email && <span className="ml-2 text-xs text-gray-400">{s.email}</span>}
                      <span className="ml-2 text-xs text-gray-500">{fmtUsd(s.baseRateCents)}/hr</span>
                      {!s.hasLogin && <span className="ml-2 text-xs text-amber-700">No login yet</span>}
                      {s.loginMissing && <span className="ml-2 text-xs text-red-600">login deleted</span>}
                      <span className={s.telegramUserId ? 'ml-2 text-xs text-green-700' : 'ml-2 text-xs text-amber-700'}>
                        {s.telegramUserId ? 'Telegram linked' : 'No Telegram'}
                      </span>
                    </span>
                    {/*
                      Fixed slots, same order on every row. Unlink is always
                      rendered and merely HIDDEN when there is no Telegram to
                      unlink: `visibility: hidden` reserves its width (and drops
                      it from hit-testing and tab order), so one person having a
                      link does not shove every other row's buttons out of
                      alignment, which is what made this list look ragged.
                    */}
                    <span className="flex shrink-0 items-center gap-3 whitespace-nowrap">
                      <span className={s.active ? 'text-xs text-green-700' : 'text-xs text-amber-700'}>
                        {s.active ? 'Active' : 'Inactive'}
                      </span>
                      <button type="button" disabled={rowBusyId === s.id} onClick={() => editRate(s)} className={action}>
                        Edit rate
                      </button>
                      <button type="button" disabled={rowBusyId === s.id} onClick={() => editTelegram(s)} className={action}>
                        {s.telegramUserId ? 'Change Telegram' : 'Link Telegram'}
                      </button>
                      <button
                        type="button"
                        aria-hidden={!s.telegramUserId}
                        tabIndex={s.telegramUserId ? undefined : -1}
                        style={s.telegramUserId ? undefined : { visibility: 'hidden' }}
                        disabled={rowBusyId === s.id || !s.telegramUserId}
                        onClick={() => unlinkTelegram(s)}
                        className={action}
                      >
                        Unlink
                      </button>
                      <button
                        type="button"
                        disabled={rowBusyId === s.id || !s.hasLogin}
                        title={s.hasLogin ? undefined : 'This person has no login yet.'}
                        onClick={() => resetPassword(s)}
                        className={action}
                      >
                        Reset password
                      </button>
                      <button type="button" disabled={rowBusyId === s.id} onClick={() => toggleActive(s)} className={action}>
                        {s.active ? 'Deactivate' : 'Activate'}
                      </button>
                    </span>
                  </li>
                ))}
                {rows.length === 0 && <li className="px-3 py-2 text-sm text-gray-500">Nobody yet.</li>}
              </ul>
            </div>
          ))}

          <form onSubmit={submit} className="mt-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-900">Add someone</h3>

            <div>
              <label className="block text-sm text-gray-700 mb-1" htmlFor="staff-type">
                Type
              </label>
              <select
                id="staff-type"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={type}
                onChange={(e) => setType(e.target.value as 'office' | 'field')}
              >
                <option value="office">Office (uses an existing operator login)</option>
                <option value="field">Field crew (creates a new crew login)</option>
              </select>
            </div>

            {type === 'office' ? (
              <div>
                <label className="block text-sm text-gray-700 mb-1" htmlFor="staff-operator">
                  Operator
                </label>
                <select
                  id="staff-operator"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                  required
                >
                  <option value="">Choose…</option>
                  {eligible.map((o) => (
                    <option key={o.id} value={o.id}>
                      {operatorLabel(o)}
                    </option>
                  ))}
                </select>
                {eligible.length === 0 && (
                  <p className="text-xs text-gray-500 mt-1">
                    No operators are available. Add a person under Staff accounts above first.
                  </p>
                )}
              </div>
            ) : null}

            <div>
              <label className="block text-sm text-gray-700 mb-1" htmlFor="staff-name">
                {type === 'office' ? 'Display name (optional)' : 'Name'}
              </label>
              <input
                id="staff-name"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={type === 'office' ? "Defaults to the operator's name" : 'e.g. Big James'}
                required={type === 'field'}
              />
            </div>

            {type === 'field' && (
              <>
                <div>
                  <label className="block text-sm text-gray-700 mb-1" htmlFor="staff-email">
                    Email
                  </label>
                  <input
                    id="staff-email"
                    type="email"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm text-gray-700 mb-1" htmlFor="staff-password">
                    Temporary password
                  </label>
                  <input
                    id="staff-password"
                    type="text"
                    className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm font-mono"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    minLength={8}
                    required
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    At least 8 characters. Give it to them directly and have them change it.
                  </p>
                </div>
              </>
            )}

            <div>
              <label className="block text-sm text-gray-700 mb-1" htmlFor="staff-rate">
                Hourly rate
              </label>
              <input
                id="staff-rate"
                inputMode="decimal"
                className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                placeholder="e.g. 22.50"
                required
              />
              <p className="text-xs text-gray-500 mt-1">
                Dollars per hour. Used to work out their pay from clocked hours.
              </p>
            </div>

            <button
              type="submit"
              disabled={busy}
              className="px-4 py-2 rounded-md text-sm font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: 'var(--brand-evergreen-3)' }}
            >
              {busy ? 'Adding…' : 'Add staff member'}
            </button>
          </form>

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          {done && <p className="mt-3 text-sm text-green-700">{done}</p>}
        </>
      )}
    </section>
  );
}
