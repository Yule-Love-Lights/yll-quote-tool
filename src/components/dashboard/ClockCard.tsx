'use client';

import { useEffect, useState } from 'react';

/**
 * Office web clock (row 337) — a COMPACT widget that lives in the dashboard
 * header, next to "Good morning." The signed-in office staffer clocks
 * themselves in/out and on/off break; identity comes from their session
 * server-side, never from here.
 *
 * The header is a server component, so this is a small self-fetching client
 * island. It always shows something once past first paint and says plainly what
 * state it is in — signed out, not linked, unavailable, or the live clock —
 * rather than vanishing on an error, which just reads as "the feature is gone".
 * After each action it re-renders from the server's truth, never an optimistic
 * guess about what a tap did.
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

/** The compact pill the header shows in every state. */
function Pill({ children }: { children: React.ReactNode }) {
  return (
    <div
      aria-label="Time clock"
      className="inline-flex items-center gap-2.5 rounded-lg border px-4 py-2 shadow-sm"
      style={{ background: 'var(--op-bg-raised)', borderColor: 'var(--op-border)' }}
    >
      {children}
    </div>
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
    return <Pill><span className="text-sm" style={dim}>Time clock…</span></Pill>;
  }

  if (load.status === 'signedout') {
    return (
      <Pill>
        <span className="text-sm" style={dim}>Time clock —</span>
        <a href="/login" className="text-sm underline" style={{ color: 'var(--op-accent)' }}>sign in</a>
      </Pill>
    );
  }

  if (load.status === 'unlinked') {
    return (
      <Pill>
        <span className="text-sm" style={dim} title="An admin can link this login under Settings → Accounts.">
          Time clock — login not linked
        </span>
      </Pill>
    );
  }

  if (load.status === 'error') {
    return (
      <Pill>
        <span className="text-sm" style={dim}>Time clock unavailable</span>
        <button
          type="button"
          onClick={() => setReload((n) => n + 1)}
          className="text-sm underline"
          style={{ color: 'var(--op-accent)' }}
        >
          retry
        </button>
      </Pill>
    );
  }

  const { state } = load;
  const label = !state.clockedIn
    ? 'Clocked out'
    : state.onBreak
      ? 'On break'
      : state.shift
        ? `In since ${clockInTime(state.shift.clockInAt)}`
        : 'Clocked in';

  return (
    <Pill>
      <span
        aria-hidden
        className="inline-block w-2.5 h-2.5 rounded-full"
        style={{ background: state.clockedIn ? (state.onBreak ? '#d97706' : '#16a34a') : 'var(--op-text-dim)' }}
      />
      <span className="text-sm font-medium whitespace-nowrap" style={{ color: 'var(--op-text)' }}>{label}</span>
      <span className="mx-1 h-4 w-px" style={{ background: 'var(--op-border)' }} aria-hidden />
      <div className="flex items-center gap-1.5">
        {actionsFor(state).map((b) => (
          <button
            key={b.action}
            type="button"
            disabled={busy}
            onClick={() => act(b.action)}
            className="rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50 whitespace-nowrap"
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
        <span className="text-sm" style={{ color: 'var(--op-danger)' }} role="alert">{error}</span>
      )}
    </Pill>
  );
}
