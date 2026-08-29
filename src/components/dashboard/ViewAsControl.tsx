'use client';

// Admin-only "View as" control (ops hub workstream A slice 2; Advertising
// wired 2026-08-29 when the #1061 surfaces landed). Office and Advertising
// are live views that swap the nav's item list; Crew sits disabled until the
// Crew My Day build exists (workstream C). Naldo's ruling: only admins
// (Naldo and Jason) get this control, for testing and review.
//
// Placement: its own full-width block row UNDER the h-12 header row, never
// inside it. The 1024px header fit has ~12px of margin (the lg:px-1.5
// comment in OperatorNav.tsx records the math), so the control must add
// zero width there; a block row adds height for admins only and no width
// for anyone.

import { useRouter } from 'next/navigation';

import { navItemsForView, OPERATOR_VIEWS } from './operatorView';
import { useOperatorView } from './OperatorViewContext';

export function ViewAsControl({ role }: { role: 'admin' | 'operator' | null }) {
  const { view, setView } = useOperatorView();
  const router = useRouter();

  // Positive admin match, same shape as the page-level operator?.role ===
  // 'admin' checks (settings/accounts, settings/bot-team, admin/fleet).
  // null covers both signed-out and the pre-fetch state: no control.
  if (role !== 'admin') return null;

  return (
    <div className="border-t" style={{ borderColor: 'var(--op-border)' }} role="group" aria-label="View as">
      <div className="max-w-6xl mx-auto px-4 py-1 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold uppercase tracking-widest" style={{ color: 'var(--op-text-2)' }}>
          View as
        </span>
        {OPERATOR_VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            disabled={!v.built}
            aria-pressed={view === v.id}
            onClick={() => {
              if (!v.built || v.id === view) return;
              // Switch AND open (audit section 6: the control "opens" the
              // views): the nav swaps immediately via the context, and the
              // browser goes to the view's first surface. The destination
              // page re-seeds the same view from its own area, so the
              // switch survives the navigation.
              setView(v.id);
              const items = navItemsForView(v.id);
              if (items.length > 0) router.push(items[0].href);
            }}
            className="px-2 py-0.5 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            style={
              view === v.id
                ? { background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }
                : { color: 'var(--op-text-2)' }
            }
          >
            {v.label}
          </button>
        ))}
        <span style={{ color: 'var(--op-text-2)' }}>Crew view is not built yet.</span>
      </div>
    </div>
  );
}
