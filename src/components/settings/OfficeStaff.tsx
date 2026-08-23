'use client';

import { useEffect, useState } from 'react';

import { dollarsToCents } from '@/lib/hourlyRate';

/**
 * Settings → Accounts → Office staff time clock (ledger #354).
 *
 * Turns an existing OPERATOR login into an office time-clock user by creating
 * their pay record (a crew_members row with is_office=true, linked to that
 * login). It replaces the hand-written SQL that used to be the only way to do it.
 *
 * This never creates a login or handles a password: the operator already has one.
 * Only operator/admin accounts appear in the picker (crew logins are excluded
 * server-side) — a crew member is set up on the Crew logins panel instead.
 */

type OfficeStaffRow = {
  id: string;
  displayName: string;
  active: boolean;
  authUserId: string | null;
  baseRateCents: number;
  operatorEmail: string | null;
  operatorName: string | null;
  operatorMissing: boolean;
};

type EligibleOperator = { id: string; name: string | null; email: string | null };

function fmtUsd(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

export function OfficeStaff() {
  const [staff, setStaff] = useState<OfficeStaffRow[]>([]);
  const [eligible, setEligible] = useState<EligibleOperator[]>([]);
  const [loading, setLoading] = useState(true);

  const [selected, setSelected] = useState('');
  const [rate, setRate] = useState('');
  const [nameOverride, setNameOverride] = useState('');
  const [busy, setBusy] = useState(false);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Fetch inside the effect with a cancelled guard (the repo's CrewLogins /
  // ClockCard pattern) so the set-state-in-effect lint rule stays green and
  // nothing sets state after unmount.
  useEffect(() => {
    let cancelled = false;

    async function fetchStaff() {
      try {
        const res = await fetch('/api/admin/office-staff');
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? 'Failed to load');
        }
        const data = (await res.json()) as { officeStaff: OfficeStaffRow[]; eligibleOperators: EligibleOperator[] };
        if (!cancelled) {
          setStaff(data.officeStaff ?? []);
          setEligible(data.eligibleOperators ?? []);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load office staff');
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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // Parse and CONFIRM the rate before sending, so a decimal-point typo
    // ("2250" meaning 22.50) is caught here — the amount is shown back as
    // dollars, not silently saved as $2,250/hr. The server re-parses the same
    // string, so this is a preview, not the source of truth.
    const cents = dollarsToCents(rate);
    if (cents === null) {
      setError('Enter a valid hourly rate, for example 22.50.');
      return;
    }
    const op = eligible.find((o) => o.id === selected);
    const who = nameOverride.trim() || op?.name || op?.email || 'this operator';
    if (!window.confirm(`Set up ${who} at ${fmtUsd(cents)} per hour?`)) return;

    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const res = await fetch('/api/admin/office-staff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authUserId: selected, hourlyRate: rate, displayName: nameOverride }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; member?: { displayName?: string } };
      if (!res.ok) throw new Error(data.error ?? 'Failed to set up office staff');
      setDone(`${data.member?.displayName ?? 'They'} can now clock in from the dashboard.`);
      setSelected('');
      setRate('');
      setNameOverride('');
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to set up office staff');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(row: OfficeStaffRow) {
    if (row.active) {
      const ok = window.confirm(
        `Deactivate ${row.displayName}? They will not be able to clock in until you activate them again.`,
      );
      if (!ok) return;
    }
    setTogglingId(row.id);
    setError(null);
    setDone(null);
    try {
      const res = await fetch('/api/admin/office-staff', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crewMemberId: row.id, active: !row.active }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; member?: { displayName?: string } };
      if (!res.ok) throw new Error(data.error ?? 'Failed to update office staff');
      setDone(
        row.active
          ? `${row.displayName} is deactivated. Their clock is off until reactivated.`
          : `${row.displayName} is active again and can clock in.`,
      );
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update office staff');
    } finally {
      setTogglingId(null);
    }
  }

  async function editRate(row: OfficeStaffRow) {
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
    setTogglingId(row.id);
    setError(null);
    setDone(null);
    try {
      const res = await fetch('/api/admin/office-staff', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crewMemberId: row.id, hourlyRate: input }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Failed to update the rate');
      setDone(`${row.displayName}'s rate is now ${fmtUsd(cents)} per hour.`);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update the rate');
    } finally {
      setTogglingId(null);
    }
  }

  const operatorLabel = (o: EligibleOperator) => o.name ?? o.email ?? 'Unnamed operator';

  return (
    <section className="mt-8 border-t border-gray-200 pt-6">
      <h2 className="text-base font-semibold text-gray-900">Office staff time clock</h2>
      <p className="text-sm text-gray-500 mt-1">
        Office staff sign in with their operator login and clock in from the dashboard. Setting
        someone up here creates their pay record so their hours are counted. This replaces editing
        the database by hand.
      </p>
      <p className="text-xs text-gray-400 mt-1">
        Only operator accounts can be set up here. Add a new person under Staff accounts above
        first, then set them up. Field crew are handled under Crew logins below, not here.
      </p>

      {loading ? (
        <p className="text-sm text-gray-500 mt-4">Loading office staff…</p>
      ) : (
        <>
          <ul className="mt-4 divide-y divide-gray-100 border border-gray-200 rounded-md">
            {staff.map((s) => (
              <li key={s.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 text-gray-900">
                  {s.displayName}
                  {s.operatorEmail && <span className="ml-2 text-xs text-gray-400">{s.operatorEmail}</span>}
                  {s.operatorMissing && (
                    <span className="ml-2 text-xs text-red-600">operator login deleted</span>
                  )}
                  <span className="ml-2 text-xs text-gray-500">{fmtUsd(s.baseRateCents)}/hr</span>
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  <span className={s.active ? 'text-xs text-green-700' : 'text-xs text-amber-700'}>
                    {s.active ? 'Active' : 'Inactive'}
                  </span>
                  <button
                    type="button"
                    disabled={togglingId === s.id}
                    onClick={() => void editRate(s)}
                    className="text-xs text-gray-500 underline disabled:opacity-50"
                  >
                    Edit rate
                  </button>
                  <button
                    type="button"
                    disabled={togglingId === s.id}
                    onClick={() => void toggleActive(s)}
                    className="text-xs text-gray-500 underline disabled:opacity-50"
                  >
                    {s.active ? 'Deactivate' : 'Activate'}
                  </button>
                </span>
              </li>
            ))}
            {staff.length === 0 && (
              <li className="px-3 py-2 text-sm text-gray-500">No office staff set up yet.</li>
            )}
          </ul>

          {eligible.length > 0 ? (
            <form onSubmit={submit} className="mt-4 space-y-3">
              <div>
                <label className="block text-sm text-gray-700 mb-1" htmlFor="office-operator">
                  Operator
                </label>
                <select
                  id="office-operator"
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
              </div>

              <div>
                <label className="block text-sm text-gray-700 mb-1" htmlFor="office-rate">
                  Hourly rate
                </label>
                <input
                  id="office-rate"
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

              <div>
                <label className="block text-sm text-gray-700 mb-1" htmlFor="office-name">
                  Display name (optional)
                </label>
                <input
                  id="office-name"
                  className="w-full border border-gray-300 rounded-md px-3 py-2 text-sm"
                  value={nameOverride}
                  onChange={(e) => setNameOverride(e.target.value)}
                  placeholder="Defaults to the operator's name"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Only needed if the name is already used by another staff member.
                </p>
              </div>

              <button
                type="submit"
                disabled={busy}
                className="px-4 py-2 rounded-md text-sm font-medium text-white disabled:opacity-50"
                style={{ backgroundColor: 'var(--brand-evergreen-3)' }}
              >
                {busy ? 'Setting up…' : 'Set up office staff'}
              </button>
            </form>
          ) : (
            <p className="mt-4 text-sm text-gray-500">
              No operators are available to set up. Add a person under Staff accounts above, then
              set them up here.
            </p>
          )}

          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
          {done && <p className="mt-3 text-sm text-green-700">{done}</p>}
        </>
      )}
    </section>
  );
}
