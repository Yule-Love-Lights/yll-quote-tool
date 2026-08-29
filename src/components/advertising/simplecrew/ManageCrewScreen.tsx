'use client';

// Manage Crew (Simple Crew replica, admin only): big title, person-add in
// the floating toolbar, the confetti empty state with Invite Crew Member —
// wired to OUR accounts door (create the worker row + mint an
// advertising-role login in one sheet, reset passwords, deactivate). The
// sign-stock reconciliation card lives here too: crew and the pile of signs
// are the same errand for the office.

import { useCallback, useEffect, useState } from 'react';

import { PersonAddIcon } from './icons';
import { EmptyState, PrimaryButton, SC, ScreenHeader, Sheet, ToolbarButton } from './ui';

type Worker = {
  id: string;
  displayName: string;
  active: boolean;
  isTest: boolean;
  hasLogin: boolean;
  email: string | null;
};

type SignStock = {
  onHandQty: number;
  reorderPoint: number;
  acceptedAllTime: number;
  pendingReview: number;
};

export default function ManageCrewScreen() {
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [stock, setStock] = useState<SignStock | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const [pwFor, setPwFor] = useState<Worker | null>(null);
  const [pwValue, setPwValue] = useState('');

  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [wRes, sRes] = await Promise.all([
          fetch('/api/admin/advertising/workers'),
          fetch('/api/admin/advertising/sign-stock'),
        ]);
        if (cancelled) return;
        if (wRes.ok) setWorkers(((await wRes.json()) as { workers: Worker[] }).workers);
        else setError('Could not load the crew.');
        setStock(sRes.ok ? ((await sRes.json()) as { stock: SignStock }).stock : null);
      } catch {
        if (!cancelled) setError('Could not load the crew.');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const call = async (method: string, body: Record<string, unknown>) => {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/admin/advertising/workers', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(payload.error ?? 'Action failed.');
        reload();
        return false;
      }
      reload();
      return true;
    } catch {
      setError('Action failed. Try again.');
      return false;
    }
  };

  const invite = async () => {
    setInviteError(null);
    if (!name.trim()) {
      setInviteError('Enter their name.');
      return;
    }
    if (email.trim() && password.length < 8) {
      setInviteError('The login password needs 8+ characters.');
      return;
    }
    setInviteBusy(true);
    try {
      const res = await fetch('/api/admin/advertising/workers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: name,
          email: email.trim() || undefined,
          password: email.trim() ? password : undefined,
        }),
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setInviteError(payload.error ?? 'Could not add them.');
        return;
      }
      setInviteOpen(false);
      setNotice(`${name.trim()} added.${email.trim() ? ` They sign in with ${email.trim()}.` : ''}`);
      setName('');
      setEmail('');
      setPassword('');
      reload();
    } catch {
      setInviteError('Could not add them. Try again.');
    } finally {
      setInviteBusy(false);
    }
  };

  const setStockCount = async () => {
    const raw = window.prompt(
      `How many yard signs are actually in stock right now? (was ${stock?.onHandQty ?? 0})\nCount the pile and type the number. Accepting a placement never changes this.`,
      String(stock?.onHandQty ?? 0),
    );
    if (raw === null) return;
    const trimmed = raw.trim();
    if (trimmed === '' || !/^\d+$/.test(trimmed)) {
      setError('Enter a whole number, 0 or more.');
      return;
    }
    const qty = Number(trimmed);
    if (qty === 0 && !window.confirm('Set the sign stock to ZERO?')) return;
    try {
      const res = await fetch('/api/admin/advertising/sign-stock', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ onHandQty: qty }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) setError(body.error ?? 'Could not save the count.');
      else setNotice(`Sign stock set to ${qty}.`);
      reload();
    } catch {
      setError('Could not save the count. Try again.');
    }
  };

  return (
    <div className="min-h-[100svh] pb-28" style={{ background: SC.bg }}>
      <ScreenHeader
        title="Manage Crew"
        toolbar={
          <ToolbarButton
            label="Invite crew member"
            onClick={() => {
              setName('');
              setEmail('');
              setPassword('');
              setInviteError(null);
              setInviteOpen(true);
            }}
          >
            <PersonAddIcon size={22} />
          </ToolbarButton>
        }
      />

      {error && (
        <p className="mx-5 mb-3 rounded-xl bg-red-50 px-4 py-3 text-sm" style={{ color: SC.danger }}>
          {error}
        </p>
      )}
      {notice && (
        <p className="mx-5 mb-3 rounded-xl px-4 py-3 text-sm" style={{ background: '#E4F2E8', color: SC.ok }}>
          {notice}
        </p>
      )}

      {stock && (
        <div className="mx-4 mb-4 rounded-2xl bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-5 text-sm">
            <Stat label="Signs in stock" value={stock.onHandQty} />
            <Stat label="Accepted, cumulative" value={stock.acceptedAllTime} />
            <Stat label="Awaiting review" value={stock.pendingReview} />
            <button
              type="button"
              onClick={() => void setStockCount()}
              className="ml-auto rounded-full border px-4 py-2"
              style={{ borderColor: '#DCD4BE', color: SC.text }}
            >
              Set counted stock…
            </button>
          </div>
          <p className="mt-2 text-xs" style={{ color: SC.muted }}>
            Reconciliation is manual on purpose: accepting a sign never moves this number.
          </p>
        </div>
      )}

      {loaded && workers.length === 0 && !error && (
        <EmptyState
          kind="crew"
          title="No Crew Yet"
          hint="Add sign crew with a login so they can capture placements from their phone."
          cta={<PrimaryButton onClick={() => { setName(''); setEmail(''); setPassword(''); setInviteError(null); setInviteOpen(true); }}>Invite Crew Member</PrimaryButton>}
        />
      )}

      <div className="flex flex-col gap-3 px-4">
        {workers.map((w) => (
          <div key={w.id} className="flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4 shadow-sm">
            <span
              className="flex h-12 w-12 items-center justify-center rounded-full text-xl font-semibold"
              style={{ background: '#F1EAD8', color: SC.muted }}
            >
              {w.displayName.slice(0, 1)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-xl font-semibold" style={{ color: w.active ? SC.text : SC.muted, textDecoration: w.active ? undefined : 'line-through' }}>
                  {w.displayName}
                </span>
                {w.isTest && (
                  <span className="rounded-full px-2 py-0.5 text-xs" style={{ background: SC.tint, color: SC.primary }}>
                    test
                  </span>
                )}
              </span>
              <span className="block truncate text-sm" style={{ color: SC.muted }}>
                {w.hasLogin ? (w.email ?? 'has a login') : 'No login yet'}
              </span>
            </span>
            <span className="flex gap-3 text-sm">
              {w.hasLogin ? (
                <button type="button" className="underline" style={{ color: SC.primary }} onClick={() => { setPwFor(w); setPwValue(''); }}>
                  Reset password
                </button>
              ) : (
                <button type="button" className="underline" style={{ color: SC.primary }} onClick={() => { setName(w.displayName); setEmail(''); setPassword(''); setInviteError(null); setInviteOpen(true); }}>
                  Create login
                </button>
              )}
              <button
                type="button"
                className="underline"
                style={{ color: SC.muted }}
                onClick={() => void call('PATCH', { workerId: w.id, active: !w.active })}
              >
                {w.active ? 'Deactivate' : 'Reactivate'}
              </button>
            </span>
          </div>
        ))}
      </div>

      {/* invite sheet */}
      <Sheet open={inviteOpen} onClose={() => setInviteOpen(false)}>
        <div style={{ color: SC.text }}>
          <h2 className="text-xl font-bold">Invite crew member</h2>
          <p className="mt-1 text-sm" style={{ color: SC.muted }}>
            They sign in at quote.yulelovelights.com and land on their own capture page. Their login
            reaches nothing else.
          </p>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className="mt-4 w-full rounded-xl border px-4 py-3 text-lg"
            style={{ borderColor: '#DCD4BE' }}
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            placeholder="Email for their login (optional)"
            className="mt-3 w-full rounded-xl border px-4 py-3 text-lg"
            style={{ borderColor: '#DCD4BE' }}
          />
          {email.trim() !== '' && (
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="text"
              placeholder="Temporary password (8+ characters)"
              className="mt-3 w-full rounded-xl border px-4 py-3 text-lg"
              style={{ borderColor: '#DCD4BE' }}
            />
          )}
          {inviteError && (
            <p className="mt-3 text-sm" style={{ color: SC.danger }}>
              {inviteError}
            </p>
          )}
          <div className="mt-5">
            <PrimaryButton disabled={inviteBusy} onClick={() => void invite()}>
              {inviteBusy ? 'Adding…' : 'Invite Crew Member'}
            </PrimaryButton>
          </div>
        </div>
      </Sheet>

      {/* password reset sheet */}
      <Sheet open={pwFor !== null} onClose={() => setPwFor(null)}>
        {pwFor && (
          <div style={{ color: SC.text }}>
            <h2 className="text-xl font-bold">New password for {pwFor.displayName}</h2>
            <input
              value={pwValue}
              onChange={(e) => setPwValue(e.target.value)}
              type="text"
              placeholder="New password (8+ characters)"
              className="mt-4 w-full rounded-xl border px-4 py-3 text-lg"
              style={{ borderColor: '#DCD4BE' }}
            />
            <div className="mt-5">
              <PrimaryButton
                disabled={pwValue.length < 8}
                onClick={async () => {
                  const ok = await call('PATCH', { workerId: pwFor.id, password: pwValue });
                  if (ok) {
                    setNotice(`${pwFor.displayName}'s password was reset.`);
                    setPwFor(null);
                  }
                }}
              >
                Reset password
              </PrimaryButton>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span>
      <span className="block text-xs uppercase tracking-wide" style={{ color: SC.muted }}>
        {label}
      </span>
      <span className="text-2xl font-bold" style={{ color: SC.text }}>
        {value}
      </span>
    </span>
  );
}
