'use client';

// The header account menu (Naldo, 2026-08-30). It replaces the loose Sign-out
// button and absorbs the admin View-as dropdown, so the header carries ONE
// identity control instead of two — which is also how the search box pays for
// its width at 1024px, where the row had about 12px to spare.
//
// What it shows: who is signed in (name, falling back to email), their role,
// links to Settings and Insights, the View-as switcher for admins, and Sign
// out. Sign out MOVED into this menu rather than disappearing; taking it away
// would strand a staffer on a shared computer with no way out.
//
// Settings and Insights moved here from the top bar (Naldo, 2026-08-31).
// Settings was reachable from two places at once, which was the complaint.
// This is now the ONLY door to it, so nothing here may be conditional on
// anything: an operator who cannot open this menu cannot reach Settings at
// all.
//
// The trigger shows initials; the name is inside the menu. See the comment on
// the trigger below for why it is not printed in the bar.

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { displayName, initials, roleLabel, type AccountIdentity } from './accountIdentity';
import { OPERATOR_VIEWS } from './operatorView';
import { useViewSwitcher } from './useViewSwitcher';

export function AccountMenu({
  identity,
  onSignOut,
}: {
  identity: AccountIdentity;
  onSignOut: () => void;
}) {
  const { view, choose: chooseView } = useViewSwitcher();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const name = displayName(identity);
  const role = roleLabel(identity.role);
  const isAdmin = identity.role === 'admin';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account menu for ${name}`}
        onClick={() => setOpen((o) => !o)}
        className="whitespace-nowrap flex items-center gap-1.5 rounded-md lg:px-1 xl:px-2 py-1 transition-colors"
        style={{ color: 'var(--op-text-2)' }}
      >
        <span
          aria-hidden
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-semibold"
          style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
        >
          {initials(identity)}
        </span>
        {/* The trigger is initials only, at EVERY width. Measured, not a
            taste call: the header row is `max-w-6xl`, so its usable width
            tops out at 1152px on any monitor, and printing the name there
            costs 80px the row does not have once the search box is in it.
            The name is one click away in the menu below, and the aria-label
            carries it for screen readers meanwhile. */}
        <span aria-hidden className="text-xs">
          ▾
        </span>
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-full z-50 mt-1 w-56 rounded-lg border shadow-lg py-1"
          style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
        >
          <div className="px-3 py-2 border-b" style={{ borderColor: 'var(--op-border)' }}>
            <p className="truncate text-sm font-semibold" style={{ color: 'var(--op-text)' }}>
              {name}
            </p>
            {/* The email only when it is not already the line above, so an
                account with no name does not print the same string twice. */}
            {identity.email && identity.email !== name && (
              <p className="truncate text-xs" style={{ color: 'var(--op-text-2)' }}>
                {identity.email}
              </p>
            )}
            {role && (
              <p className="text-xs" style={{ color: 'var(--op-text-2)' }}>
                {role}
              </p>
            )}
          </div>

          {/* Both are plain links for EVERY role, admin or not. They are the
              only doors to these two pages now that the tabs are gone. */}
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-1.5 text-sm hover:bg-black/5"
            style={{ color: 'var(--op-text-2)' }}
          >
            Settings
          </Link>
          <Link
            href="/insights"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="block px-3 py-1.5 text-sm hover:bg-black/5"
            style={{ color: 'var(--op-text-2)' }}
          >
            Insights
          </Link>

          {isAdmin && (
            <>
              <div className="my-1 border-t" style={{ borderColor: 'var(--op-border)' }} />
              <p
                className="px-3 pt-1 pb-0.5 text-[10px] font-semibold uppercase tracking-widest"
                style={{ color: 'var(--op-text-2)' }}
              >
                View as
              </p>
              {OPERATOR_VIEWS.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  role="menuitem"
                  disabled={!v.built}
                  onClick={() => {
                    setOpen(false);
                    chooseView(v.id);
                  }}
                  className="block w-full text-left px-3 py-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-black/5"
                  style={
                    v.id === view
                      ? { color: 'var(--brand-evergreen)', fontWeight: 600 }
                      : { color: 'var(--op-text-2)' }
                  }
                >
                  {v.id === view ? '✓ ' : ''}
                  {v.label}
                  {!v.built && <span className="ml-1 text-xs">(not built yet)</span>}
                </button>
              ))}
            </>
          )}

          <div className="my-1 border-t" style={{ borderColor: 'var(--op-border)' }} />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onSignOut();
            }}
            className="block w-full text-left px-3 py-1.5 text-sm hover:bg-black/5"
            style={{ color: 'var(--op-text-2)' }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
