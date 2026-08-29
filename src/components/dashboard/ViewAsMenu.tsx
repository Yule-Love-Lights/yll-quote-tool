'use client';

// The header "View as" menu (Naldo's design, 2026-08-29): a compact button
// in the top header that opens a dropdown listing the views, replacing the
// full-width strip the first cut used. It lives in the SLOT the Sign-out
// button occupies, so the 1024px row fit (#1043's ~12px margin) is spent
// once, not twice: for an admin the slot renders this menu (with Sign out as
// the dropdown's last item), for everyone else it renders the plain Sign-out
// button exactly as before — zero change for operators.
//
// The dropdown is absolutely positioned (no layout impact when open) and
// closes on outside click and Escape. Choosing a built view switches the
// context AND opens the view's first surface; the destination page re-seeds
// the view from its own area, so the switch survives navigation.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { navItemsForView, OPERATOR_VIEWS } from './operatorView';
import { useOperatorView } from './OperatorViewContext';

/** The switch itself, shared by the desktop menu and the mobile rows:
 * switching a BUILT view updates the context (instant nav swap) and opens
 * the view's first surface; the destination re-seeds the view from its own
 * area, so the switch survives navigation. */
export function useViewSwitcher() {
  const { view, setView } = useOperatorView();
  const router = useRouter();
  const choose = (id: (typeof OPERATOR_VIEWS)[number]['id']) => {
    if (id === view) return;
    setView(id);
    const items = navItemsForView(id);
    if (items.length > 0) router.push(items[0].href);
  };
  return { view, choose };
}

export function ViewAsMenu({ onSignOut }: { onSignOut: () => void }) {
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

  const choose = (id: (typeof OPERATOR_VIEWS)[number]['id']) => {
    setOpen(false);
    chooseView(id);
  };

  const currentLabel = OPERATOR_VIEWS.find((v) => v.id === view)?.label ?? 'Office';

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="whitespace-nowrap lg:px-2 xl:px-3 py-1.5 rounded-md transition-colors"
        style={{ color: 'var(--op-text-2)' }}
      >
        View as ▾
      </button>
      {open && (
        <div
          role="menu"
          aria-label="View as"
          className="absolute right-0 top-full z-50 mt-1 w-48 rounded-lg border shadow-lg py-1"
          style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
        >
          {OPERATOR_VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="menuitem"
              disabled={!v.built}
              onClick={() => choose(v.id)}
              className="block w-full text-left px-3 py-1.5 text-sm disabled:opacity-50 disabled:cursor-not-allowed hover:bg-black/5"
              style={v.id === view ? { color: 'var(--brand-evergreen)', fontWeight: 600 } : { color: 'var(--op-text-2)' }}
            >
              {v.id === view ? '✓ ' : ''}
              {v.label}
              {!v.built && <span className="ml-1 text-xs">(not built yet)</span>}
            </button>
          ))}
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
      <span className="sr-only">Current view: {currentLabel}</span>
    </div>
  );
}
