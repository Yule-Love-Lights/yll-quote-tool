'use client';

import { useEffect, useState } from 'react';

/**
 * Office web clock card (row 337) — the dashboard-home face of
 * /api/office/clock. The signed-in office staffer clocks themselves in/out and
 * on/off break; identity comes from their session server-side, never from here.
 *
 * The page is a server component, so this is a small self-fetching client
 * island. It renders NOTHING until it knows the caller's state, shows a quiet
 * setup hint when the login isn't linked to a staff record yet (a fail-closed
 * 403, not an error), and always re-reads the server's truth after each action
 * rather than trusting an optimistic guess about what a tap did.
 */

export type ClockState = {
  clockedIn: boolean;
  onBreak: boolean;
  shift: { clockInAt: string } | null;
  staff: { name: string };
};

/**
 * The buttons to show for a clock state — a pure function so the state machine
 * is testable without a DOM. Clock-out and break controls only exist while
 * clocked in; break-start and break-end are mutually exclusive.
 */
export function actionsFor(state: { clockedIn: boolean; onBreak: boolean }): Array<{
  action: 'in' | 'out' | 'break-start' | 'break-end';
  label: string;
  kind: 'primary' | 'secondary';
}> {
  if (!state.clockedIn) {
    return [{ action: 'in', label: 'Clock in', kind: 'primary' }];
  }
  const out = { action: 'out' as const, label: 'Clock out', kind: 'primary' as const };
  const brk = state.onBreak
    ? { action: 'break-end' as const, label: 'End break', kind: 'secondary' as const }
    : { action: 'break-start' as const, label: 'Start break', kind: 'secondary' as const };
  return [out, brk];
}

function clockInTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

type Load = { status: 'loading' } | { status: 'hidden' } | { status: 'unlinked' } | { status: 'ready'; state: ClockState };

export function ClockCard() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mount-time read of the caller's current clock state. Inlined with a
  // `cancelled` guard (the repo's CrewLogins pattern) so the lint rule against
  // effect-driven setState is satisfied and no state is set after unmount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/office/clock', { method: 'GET' });
        if (cancelled) return;
        if (res.status === 403) {
          // is_crew or unlinked — the card offers a quiet hint, not an error.
          setLoad({ status: 'unlinked' });
          return;
        }
        if (!res.ok) {
          // 401 (won't happen behind the operator gate) or a transient fault:
          // hide rather than clutter the dashboard with a red box.
          setLoad({ status: 'hidden' });
          return;
        }
        const state = (await res.json()) as ClockState;
        if (!cancelled) setLoad({ status: 'ready', state });
      } catch {
        if (!cancelled) setLoad({ status: 'hidden' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function act(action: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/office/clock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const body = (await res.json().catch(() => null)) as (ClockState & { error?: string }) | null;
      if (!res.ok) {
        setError(body?.error ?? 'Something went wrong. Try again.');
        return;
      }
      if (body) setLoad({ status: 'ready', state: body });
    } catch {
      setError('Could not reach the clock. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (load.status === 'loading' || load.status === 'hidden') return null;

  if (load.status === 'unlinked') {
    return (
      <section
        aria-label="Time clock"
        className="rounded-lg border p-4"
        style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
      >
        <div className="flex items-baseline justify-between mb-1">
          <h3 className="text-base font-semibold" style={{ color: 'var(--op-text)' }}>Time clock</h3>
        </div>
        <p className="text-sm" style={{ color: 'var(--op-text-dim)' }}>
          This login isn’t linked to a staff record yet, so it can’t clock in. An admin can link it under Settings → Accounts.
        </p>
      </section>
    );
  }

  const { state } = load;
  const status = !state.clockedIn
    ? 'Clocked out'
    : state.onBreak
      ? 'On break'
      : state.shift
        ? `Clocked in since ${clockInTime(state.shift.clockInAt)}`
        : 'Clocked in';

  return (
    <section
      aria-label="Time clock"
      className="rounded-lg border p-4"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-base font-semibold" style={{ color: 'var(--op-text)' }}>Time clock</h3>
        <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>{state.staff.name}</span>
      </div>

      <p className="text-sm mb-3" style={{ color: 'var(--op-text)' }}>
        <span
          aria-hidden
          className="inline-block w-2 h-2 rounded-full mr-2 align-middle"
          style={{ background: state.clockedIn ? (state.onBreak ? '#d97706' : '#16a34a') : 'var(--op-text-dim)' }}
        />
        {status}
      </p>

      <div className="flex flex-wrap gap-2">
        {actionsFor(state).map((b) => (
          <button
            key={b.action}
            type="button"
            disabled={busy}
            onClick={() => act(b.action)}
            className="rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
            style={
              b.kind === 'primary'
                ? { background: 'var(--op-accent)', color: '#1c1917' }
                : { background: 'var(--op-bg)', color: 'var(--op-text)', border: '1px solid var(--op-border)' }
            }
          >
            {b.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="text-sm mt-3" style={{ color: 'var(--op-danger)' }} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
