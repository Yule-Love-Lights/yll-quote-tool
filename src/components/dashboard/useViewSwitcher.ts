'use client';

// The view switch, shared by the header account menu and the mobile rows.
// Lived in ViewAsMenu.tsx until the account menu absorbed that dropdown
// (Naldo, 2026-08-30); the hook itself is unchanged.

import { useRouter } from 'next/navigation';

import { navItemsForView, OPERATOR_VIEWS } from './operatorView';
import { useOperatorView } from './OperatorViewContext';

/**
 * Switching a BUILT view updates the context (instant nav swap) and opens the
 * view's first surface; the destination re-seeds the view from its own area,
 * so the switch survives navigation.
 */
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
