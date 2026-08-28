'use client';

// Admin-only "View as" control (ops hub workstream A slice 2). A stub with
// honest copy: it lists the three populations, Office is the only live view,
// and Crew/Advertising sit disabled until their builds exist (workstreams C
// and B). Naldo's ruling: only admins (Naldo and Jason) get this control,
// for testing and review of the later views.
//
// Placement: its own full-width block row UNDER the h-12 header row, never
// inside it. The 1024px header fit has ~12px of margin (the lg:px-1.5
// comment in OperatorNav.tsx records the math), so the control must add
// zero width there; a block row adds height for admins only and no width
// for anyone.

import { OPERATOR_VIEWS } from './operatorView';
import { useOperatorView } from './OperatorViewContext';

export function ViewAsControl({ role }: { role: 'admin' | 'operator' | null }) {
  const { view, setView } = useOperatorView();

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
              if (v.built) setView(v.id);
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
        <span style={{ color: 'var(--op-text-2)' }}>Crew and Advertising views are not built yet.</span>
      </div>
    </div>
  );
}
