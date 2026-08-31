'use client';

// Settings (Simple Crew replica): sectioned rows with the outline icons —
// Change Password, Sign Out — plus mode-specific rows. No support/help
// section on purpose (Naldo's device round, 2026-08-29: "we are the
// support"). The admin page passes the Pay summary as paySection so pay
// and settings are one screen; the routine rows (password, sign out, the
// back-to-the-quote-tool link) stay on top so a long pay history never
// buries them (staff lens, PR #1090).

import { useState } from 'react';

import { SC, ScreenHeader, Sheet, PrimaryButton } from './ui';
import { ChevronRightIcon } from './icons';

export default function SettingsScreen({
  passwordUrl,
  logoutUrl,
  extraRows,
  paySection,
  extraSection,
}: {
  passwordUrl: string;
  logoutUrl: string;
  extraRows?: { label: string; href: string }[];
  /** Rendered below the Account rows (the admin Pay summary). */
  paySection?: React.ReactNode;
  /** Rendered after paySection: sign allotments for an admin, the
   * worker's own remaining count for crew. */
  extraSection?: React.ReactNode;
}) {
  const [pwOpen, setPwOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<string | null>(null);

  const changePassword = async () => {
    setPwMsg(null);
    if (pw.length < 8) {
      setPwMsg('Password must be at least 8 characters.');
      return;
    }
    if (pw !== pw2) {
      setPwMsg('The two passwords do not match.');
      return;
    }
    setPwBusy(true);
    try {
      const res = await fetch(passwordUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setPwMsg(body.error ?? 'Could not change the password.');
        return;
      }
      setPwMsg('Password changed.');
      setPw('');
      setPw2('');
    } catch {
      setPwMsg('Could not change the password. Try again.');
    } finally {
      setPwBusy(false);
    }
  };

  const signOut = async () => {
    try {
      await fetch(logoutUrl, { method: 'POST' });
    } finally {
      window.location.href = '/login';
    }
  };

  return (
    <div className="min-h-[100svh] pb-28" style={{ background: SC.bg }}>
      <ScreenHeader title="Settings" />

      <p className="px-5 pb-2 text-sm font-semibold uppercase tracking-wide" style={{ color: SC.muted }}>
        Account
      </p>
      <div className="bg-white">
        <Row label="Change Password" icon={<LockGlyph />} onClick={() => setPwOpen(true)} />
        <Row label="Sign Out" icon={<SignOutGlyph />} onClick={() => void signOut()} />
        {extraRows?.map((r) => (
          <Row key={r.href} label={r.label} icon={<ChevronRightIcon size={20} />} href={r.href} />
        ))}
      </div>

      {paySection && <div className="mt-8">{paySection}</div>}

      {extraSection}

      <Sheet open={pwOpen} onClose={() => setPwOpen(false)}>
        <div style={{ color: SC.text }}>
          <h2 className="text-xl font-bold">Change password</h2>
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="New password (8+ characters)"
            className="mt-4 w-full rounded-xl border px-4 py-3 text-lg"
            style={{ borderColor: '#DCD4BE' }}
          />
          <input
            type="password"
            value={pw2}
            onChange={(e) => setPw2(e.target.value)}
            placeholder="Repeat it"
            className="mt-3 w-full rounded-xl border px-4 py-3 text-lg"
            style={{ borderColor: '#DCD4BE' }}
          />
          {pwMsg && (
            <p className="mt-3 text-sm" style={{ color: pwMsg === 'Password changed.' ? SC.ok : SC.danger }}>
              {pwMsg}
            </p>
          )}
          <div className="mt-5">
            <PrimaryButton disabled={pwBusy} onClick={() => void changePassword()}>
              {pwBusy ? 'Saving…' : 'Change Password'}
            </PrimaryButton>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

function Row({ label, icon, onClick, href }: { label: string; icon: React.ReactNode; onClick?: () => void; href?: string }) {
  const inner = (
    <span className="flex w-full items-center gap-4 border-b px-5 py-4" style={{ borderColor: '#F1EBDB' }}>
      <span style={{ color: SC.primary }}>{icon}</span>
      <span className="flex-1 text-left text-lg" style={{ color: SC.text }}>
        {label}
      </span>
      <ChevronRightIcon size={20} className="opacity-40" />
    </span>
  );
  if (href) {
    return (
      <a href={href} className="block">
        {inner}
      </a>
    );
  }
  return (
    <button type="button" onClick={onClick} className="block w-full">
      {inner}
    </button>
  );
}

const LockGlyph = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
    <rect x="5" y="10" width="14" height="10" rx="2.5" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </svg>
);

const SignOutGlyph = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 4H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h8M10 12h10M17 9l3 3-3 3" />
  </svg>
);

