'use client';

import { useEffect, useState } from 'react';

import { dollarsToCents } from '@/lib/hourlyRate';
import { isValidTelegramUserId } from '@/lib/telegramUserId';
import { SkeletonBar, SkeletonRows } from '@/components/ui/LoadingSkeleton';

/**
 * Settings → Accounts → Staff (ledger #354, unified 2026-08-24).
 *
 * ONE list of every staff member, office and field. Naldo's ruling after driving
 * the two old panels: they did the same job in two different shapes, so
 * "everything needs to be exactly the same to make it easier to understand".
 *
 * Every row gets the same actions — Edit rate, Link/Change/Unlink Telegram,
 * Reset password, Move between office and field, Activate/Deactivate, Remove —
 * and the office/field difference is a GROUP HEADING, not a different screen.
 *
 * The one place the two genuinely differ is ADDING someone: office staff link an
 * existing operator login; field crew get NO login (row 438). That is a
 * permission boundary, not a presentation choice.
 *
 * Admin access is a BADGE, deliberately not a third group. Role and
 * dispatchability are independent facts — Jason is an admin sitting on a field
 * row — so grouping by role would pull people out of the group that answers
 * "who can I assign to this job", which is the only thing the office/field flag
 * actually controls. Roles are granted in the Staff accounts table above.
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
  role: 'admin' | 'operator' | null;
  isCrewLogin: boolean;
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
  const [rate, setRate] = useState('');
  const [busy, setBusy] = useState(false);
  const [rowBusyId, setRowBusyId] = useState<string | null>(null);
  const [linkSel, setLinkSel] = useState<Record<string, string>>({});

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
            : { type, displayName: name, hourlyRate: rate },
        ),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; member?: { displayName?: string } };
      if (!res.ok) throw new Error(data.error ?? 'Failed to add the staff member');
      setDone(`${data.member?.displayName ?? who} was added.`);
      setSelected('');
      setName('');
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

  function linkLogin(row: StaffRow) {
    // The other half of the row-359 repair. Clearing a dead pointer only helps
    // if the row can then be given a working login, and POST cannot do it: POST
    // always INSERTS, so re-adding the same person collides with the unique
    // display name. This attaches an existing operator to THIS row.
    const authUserId = linkSel[row.id];
    if (!authUserId) return;
    const op = eligible.find((o) => o.id === authUserId);
    if (!window.confirm(`Give ${row.displayName} the login ${operatorLabel(op ?? { id: '', name: null, email: null })}?`)) {
      return;
    }
    void patchRow(row, { authUserId }, `${row.displayName} can sign in again.`);
  }

  function clearStaleLogin(row: StaffRow) {
    // Only offered for a row the server already reported as loginMissing, and
    // the server re-checks that the login really is gone before clearing. The
    // point is to make the row linkable again: while a dead id sits in the
    // column, adding a replacement login is refused as "already has one".
    if (
      !window.confirm(
        `${row.displayName}'s login no longer exists. Clear the link so you can give them a new one? This does not delete anything else.`,
      )
    ) {
      return;
    }
    void patchRow(
      row,
      { clearLogin: true },
      `${row.displayName}'s stale login link is cleared. Pick an operator on their row to give them a working login.`,
    );
  }

  function moveType(row: StaffRow) {
    // The flag's only effect is the job-assignment roster, so the confirm says
    // exactly that rather than implying something about their login or clock.
    const next = !row.isOffice;
    const message = next
      ? `Move ${row.displayName} to office? They will no longer be offered when you assign crew to a job.`
      : `Move ${row.displayName} to field crew? They will start being offered when you assign crew to a job.`;
    if (!window.confirm(message)) return;
    void patchRow(
      row,
      { isOffice: next },
      `${row.displayName} is now ${next ? 'office' : 'field crew'}.`,
    );
  }

  async function removeStaff(row: StaffRow) {
    // Irreversible, so the confirm names exactly what goes and what stays, and
    // points at the reversible alternative first. Anyone with recorded time is
    // refused server-side by the database's own foreign keys, so the worst a
    // mis-click can do to a real worker is show them that refusal.
    // Based on the REAL login type, not on the office/field group: the server
    // deletes a login only when it is a crew one, and those two facts can differ
    // (someone moved between groups keeps whatever login they already had).
    const alsoLogin = row.isCrewLogin ? ' Their crew login is deleted too.' : '';
    if (
      !window.confirm(
        `Remove ${row.displayName} completely? This cannot be undone.${alsoLogin} If they have any recorded time or job history, this will be refused and you should Deactivate instead, which keeps their records.`,
      )
    ) {
      return;
    }
    setRowBusyId(row.id);
    setError(null);
    setDone(null);
    try {
      const res = await fetch('/api/admin/staff', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crewMemberId: row.id }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; loginDeleted?: boolean };
      if (!res.ok) throw new Error(data.error ?? 'Failed to remove them');
      setDone(
        data.loginDeleted
          ? `${row.displayName} and their crew login were removed.`
          : `${row.displayName} was removed.`,
      );
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove them');
    } finally {
      setRowBusyId(null);
    }
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
        Everyone who clocks in. The two groups below differ in one way only: whether they are
        offered when you assign crew to a job.
      </p>
      <p className="text-sm text-gray-500 mt-2">
        How someone clocks in depends on their LOGIN, not on their group. An operator or admin
        login can clock in from the dashboard header, and by texting the bot once Telegram is
        linked. Someone with no login clocks in by texting the bot only. Each row says which
        login it has.
      </p>
      <p className="text-xs text-gray-500 mt-2">
        Linking Telegram is necessary but not enough on its own: the bot only reads chats on its
        allow list, so texting works in a group the bot is already in, while a one-to-one chat also
        needs that same id added to TELEGRAM_ALLOWED_CHATS. Until then their texts are ignored
        silently, with no error shown to them.
      </p>

      {loading ? (
        // Row 410, fix round (staff lens LOW): mirror the real structure —
        // two GROUPS (Office, Field crew), each a heading + hint line + rows —
        // not a flat list that grows headings on load. Rows stay h-16: the
        // list is two lines per person (identity above, actions below).
        <div role="status" aria-busy="true" className="mt-4">
          <SkeletonBar className="h-4 w-20 mb-1" />
          <SkeletonBar className="h-3 w-56 mb-2" />
          <SkeletonRows label="" announce={false} rows={2} rowClassName="h-16" className="flex flex-col gap-2 mb-4" />
          <SkeletonBar className="h-4 w-20 mb-1" />
          <SkeletonBar className="h-3 w-56 mb-2" />
          <SkeletonRows label="" announce={false} rows={2} rowClassName="h-16" className="flex flex-col gap-2" />
          <span className="sr-only">Loading staff…</span>
        </div>
      ) : (
        <>
          {groups.map(({ label, rows, hint }) => (
            <div key={label} className="mt-4">
              <h3 className="text-sm font-semibold text-gray-900">{label}</h3>
              <p className="text-xs text-gray-500 mb-2">{hint}</p>
              <ul className="divide-y divide-gray-100 border border-gray-200 rounded-md">
                {rows.map((s) => (
                  <li key={s.id} className="px-3 py-2 text-sm">
                    {/*
                      Two lines, not one. Seven actions plus the name, email,
                      rate, login type and Telegram state do not fit side by side
                      in this page's max-w-3xl column, and squeezing the identity
                      half to a sliver is the opposite of the readability this
                      panel was rebuilt for. Actions sit on their own line, where
                      they align across rows for free.
                    */}
                    <div className="min-w-0">
                      <span className="text-gray-900">{s.displayName}</span>
                      {s.role === 'admin' && (
                        <span
                          className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700"
                          title="Can manage accounts and settings. Change this under Staff accounts above."
                        >
                          Admin
                        </span>
                      )}
                      {s.email && <span className="ml-2 text-xs text-gray-400">{s.email}</span>}
                      <span className="ml-2 text-xs text-gray-500">{fmtUsd(s.baseRateCents)}/hr</span>
                      {!s.hasLogin && <span className="ml-2 text-xs text-amber-700">No login yet</span>}
                      {s.loginMissing && <span className="ml-2 text-xs text-red-600">login deleted</span>}
                      <span className={s.telegramUserId ? 'ml-2 text-xs text-green-700' : 'ml-2 text-xs text-amber-700'}>
                        {s.telegramUserId ? 'Telegram linked' : 'No Telegram'}
                      </span>
                      {s.hasLogin && (
                        <span className="ml-2 text-xs text-gray-400">
                          {s.isCrewLogin ? 'Crew login — texts the bot only' : 'Operator login — dashboard or bot'}
                        </span>
                      )}
                    </div>
                    {/*
                      Fixed slots, same order on every row. Unlink is always
                      rendered and merely HIDDEN when there is no Telegram to
                      unlink: `visibility: hidden` reserves its width (and drops
                      it from hit-testing and tab order), so one person having a
                      link does not shove every other row's buttons out of
                      alignment, which is what made this list look ragged.
                    */}
                    {!s.hasLogin && eligible.length > 0 && (
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <label className="text-xs text-gray-500" htmlFor={`link-${s.id}`}>
                        Give them a login:
                      </label>
                      <select
                        id={`link-${s.id}`}
                        className="border border-gray-300 rounded-md px-2 py-1 text-xs"
                        value={linkSel[s.id] ?? ''}
                        onChange={(e) => setLinkSel((m) => ({ ...m, [s.id]: e.target.value }))}
                      >
                        <option value="">Choose an operator…</option>
                        {eligible.map((o) => (
                          <option key={o.id} value={o.id}>
                            {operatorLabel(o)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        disabled={rowBusyId === s.id || !linkSel[s.id]}
                        onClick={() => linkLogin(s)}
                        className={action}
                      >
                        Link
                      </button>
                    </div>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-3">
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
                      {/*
                        Always rendered, hidden when there is nothing stale to
                        clear — the same convention as Unlink above, so one
                        orphaned row does not shove every other row's buttons
                        out of alignment.
                      */}
                      <button
                        type="button"
                        aria-hidden={!s.loginMissing}
                        tabIndex={s.loginMissing ? undefined : -1}
                        style={s.loginMissing ? undefined : { visibility: 'hidden' }}
                        disabled={rowBusyId === s.id || !s.loginMissing}
                        onClick={() => clearStaleLogin(s)}
                        className="text-xs text-red-600 underline disabled:opacity-50"
                      >
                        Clear stale login
                      </button>
                      <button type="button" disabled={rowBusyId === s.id} onClick={() => moveType(s)} className={action}>
                        {s.isOffice ? 'Move to field' : 'Move to office'}
                      </button>
                      <button type="button" disabled={rowBusyId === s.id} onClick={() => toggleActive(s)} className={action}>
                        {s.active ? 'Deactivate' : 'Activate'}
                      </button>
                      <button
                        type="button"
                        disabled={rowBusyId === s.id}
                        onClick={() => void removeStaff(s)}
                        className="text-xs text-red-600 underline disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
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
                <option value="field">Field crew (no login: they use the Telegram bot)</option>
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
