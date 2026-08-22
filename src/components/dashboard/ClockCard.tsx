'use client';

import { useEffect, useState } from 'react';

/**
 * Office web clock card (row 337) — the dashboard-home face of
 * /api/office/clock. The signed-in office staffer clocks themselves in/out and
 * on/off break; identity comes from their session server-side, never from here.
 *
 * The page is a server component, so this is a small self-fetching client
 * island. It ALWAYS renders the "Time clock" card once past the first paint and
 * says plainly what state it is in — signed out, not linked, unavailable, or
 * the live clock — rather than vanishing on an error, which just reads as "the
 * feature is missing". After each action it re-renders from the server's truth,
 * never an optimistic guess about what a tap did.
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

type Load =
  | { status: 'loading' }
  | { status: 'signedout' }
  | { status: 'unlinked' }
  | { status: 'error' }
  | { status: 'ready'; state: ClockState };

/** Shared card chrome so every state looks like the same card, not a new one. */
function Shell({ name, children }: { name?: string; children: React.ReactNode }) {
  return (
    <section
      aria-label="Time clock"
      className="rounded-lg border p-4"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-base font-semibold" style={{ color: 'var(--op-text)' }}>Time clock</h3>
        {name && <span className="text-xs" style={{ color: 'var(--op-text-dim)' }}>{name}</span>}
      </div>
      {children}
    </section>
  );
}

export function ClockCard() {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mount-time (and retry) read of the caller's current clock state. Inlined
  // with a `cancelled` guard (the repo's CrewLogins pattern) so the lint rule
  // against effect-driven setState stays green and nothing sets state after
  // unmount. `reload` re-runs it for the retry button.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/office/clock', { method: 'GET' });
        if (cancelled) return;
        if (res.status === 401) return setLoad({ status: 'signedout' });
        if (res.status === 403) return setLoad({ status: 'unlinked' });
        if (!res.ok) return setLoad({ status: 'error' });
        const state = (await res.json()) as ClockState;
        if (!cancelled) setLoad({ status: 'ready', state });
      } catch {
        if (!cancelled) setLoad({ status: 'error' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reload]);

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

  const dim = { color: 'var(--op-text-dim)' } as const;

  if (load.status === 'loading') {
    return <Shell><p className="text-sm" style={dim}>Loading…</p></Shell>;
  }

  if (load.status === 'signedout') {
    return (
      <Shell>
        <p className="text-sm" style={dim}>
          You’re not signed in to the time clock.{' '}
          <a href="/login" className="underline" style={{ color: 'var(--op-accent)' }}>Sign in</a> to clock in.
        </p>
      </Shell>
    );
  }

  if (load.status === 'unlinked') {
    return (
      <Shell>
        <p className="text-sm" style={dim}>
          This login isn’t linked to a staff record yet, so it can’t clock in. An admin can link it under Settings → Accounts.
        </p>
      </Shell>
    );
  }

  if (load.status === 'error') {
    return (
      <Shell>
        <p className="text-sm mb-3" style={dim}>The time clock is temporarily unavailable.</p>
        <button
          type="button"
          onClick={() => setReload((n) => n + 1)}
          className="rounded-md px-3 py-2 text-sm font-medium"
          style={{ background: 'var(--op-bg)', color: 'var(--op-text)', border: '1px solid var(--op-border)' }}
        >
          Retry
        </button>
      </Shell>
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
    <Shell name={state.staff.name}>
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
    </Shell>
  );
}
