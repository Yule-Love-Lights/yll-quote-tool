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
  | { status: 'inactive' }
  | { status: 'is_advertising' }
  | { status: 'error' }
  | { status: 'ready'; state: ClockState };

/**
 * Maps a 403's `reason` body field (from getOfficeClockCaller/officeDenialResponse,
 * src/lib/auth/officeClock.ts) to the card's blocked-state status. Pure, so the
 * classification is testable without a DOM (same reasoning as actionsFor above).
 *
 * ⚠️ advertising role hardening fix round: 'is_advertising' MUST be its own named
 * branch here, not fall through to the 'unlinked' default. Before this, EVERY
 * reason other than 'inactive' (including 'is_advertising', and the pre-existing
 * 'is_crew') collapsed into 'unlinked', which renders "ask an admin to set it up" —
 * a claim that will never be true for an advertising account, since there is no
 * admin action that turns one into a linkable staffer. 'is_crew' is left on the
 * default for now (out of scope for this fix; in practice a crew session never
 * reaches this route in the first place, since the perimeter confines it to the
 * crew API before getOfficeClockCaller ever runs) — narrowing that one is a
 * separate, deliberate follow-up, not a silent side effect of this change.
 */
export function statusFor403(reason: string | undefined): 'unlinked' | 'inactive' | 'is_advertising' {
  if (reason === 'inactive') return 'inactive';
  if (reason === 'is_advertising') return 'is_advertising';
  return 'unlinked';
}

/**
 * The copy for the 'is_advertising' blocked state. Pure and separately testable
 * (same reasoning as statusFor403 above) so a future edit can't silently make
 * this honest-but-plain message drift back into an "ask an admin" claim that
 * doesn't apply to this population.
 */
export function advertisingBlockedCopy(): { headline: string; title: string } {
  return {
    headline: 'Time clock — not available',
    title: 'Advertising accounts do not use the staff clock.',
  };
}

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
        if (res.status === 403) {
          // Two (now three) 403s look the same by status. The body's reason
          // tells apart a login that was never linked, one that was
          // deactivated, and one that has no clock surface at all — see
          // statusFor403's doc comment for why each needs its own branch.
          const body = (await res.json().catch(() => ({}))) as { reason?: string };
          if (cancelled) return;
          return setLoad({ status: statusFor403(body.reason) });
        }
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
      const body = (await res.json().catch(() => null)) as
        | (ClockState & { error?: string; reason?: string })
        | null;
      if (!res.ok) {
        // A 403 mid-session means the account was just deactivated or unlinked
        // (e.g. an admin changed it in another tab). Transition to that state's
        // messaging instead of leaving stale live-looking buttons that keep
        // failing with a generic error.
        if (res.status === 403) {
          setLoad({ status: statusFor403(body?.reason) });
          return;
        }
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
        <span
          className="text-sm"
          style={dim}
          title="This login isn't linked to a staff time record yet — ask an admin to set it up."
        >
          Time clock — login not linked
        </span>
        <button
          type="button"
          onClick={() => setReload((n) => n + 1)}
          className="text-sm underline"
          style={{ color: 'var(--op-accent)' }}
        >
          refresh
        </button>
      </Pill>
    );
  }

  if (load.status === 'is_advertising') {
    // No refresh button here, unlike unlinked/inactive: those are transient
    // misconfigurations an admin can fix (link the login, reactivate the
    // record), so retrying makes sense. An advertising login never becomes a
    // staffer — this is a structural, permanent state, not a "fix me" one.
    const copy = advertisingBlockedCopy();
    return (
      <Pill>
        <span className="text-sm" style={dim} title={copy.title}>
          {copy.headline}
        </span>
      </Pill>
    );
  }

  if (load.status === 'inactive') {
    return (
      <Pill>
        <span
          className="text-sm"
          style={dim}
          title="Your staff record is inactive — ask an admin to reactivate it before clocking in."
        >
          Time clock — account inactive
        </span>
        <button
          type="button"
          onClick={() => setReload((n) => n + 1)}
          className="text-sm underline"
          style={{ color: 'var(--op-accent)' }}
        >
          refresh
        </button>
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
