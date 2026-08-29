// Operator view context (ops hub workstream A slice 2, audit sections 6/8A).
//
// Every operator's view is 'office' today. 'crew' and 'advertising' are the
// later Crew My Day and Advertising worker builds: they exist here so the
// admin View-as control can list them honestly (disabled, not built yet) and
// so those builds wire themselves up by extending this data, not by
// rewriting OperatorNav.

import type { OperatorArea } from '@/components/OperatorShell';

export type OperatorView = 'office' | 'crew' | 'advertising';

// built: whether the view's destination surfaces exist. The View-as control
// renders unbuilt views disabled; navItemsForView returns items only for
// built views. Flipping built to true is each later build's job, in the same
// PR that ships that view's pages.
export const OPERATOR_VIEWS: ReadonlyArray<{ id: OperatorView; label: string; built: boolean }> = [
  { id: 'office', label: 'Office', built: true },
  { id: 'crew', label: 'Crew', built: false },
  { id: 'advertising', label: 'Advertising', built: false },
];

export type NavItem = { label: string; href: string; match: OperatorArea[] };

// Top-level operator areas, in the order Naldo specified. "New quote" lives on
// the dashboard CTA + the Quotes page (so /quote/* highlights Quotes); Training
// lives under Settings (so /training/* highlights Settings) — neither is a
// top-level item.
const OFFICE_ITEMS: NavItem[] = [
  { label: 'Home', href: '/', match: ['home'] },
  { label: 'Inbox', href: '/inbox', match: ['inbox'] },
  // Leads deliberately has NO nav item (Jason, 2026-08-26): the /admin/leads
  // page and everything behind it stay live — reachable by URL and from any
  // in-app links — it just doesn't earn a top-level slot. Visiting it renders
  // no highlighted tab (its 'leads' OperatorArea matches nothing here), which
  // is expected. Re-adding is one line: { label: 'Leads', href: '/admin/leads', match: ['leads'] }.
  { label: 'Customers', href: '/customers', match: ['customers'] },
  { label: 'Quotes', href: '/admin/quotes', match: ['quotes', 'new'] },
  { label: 'Jobs', href: '/admin/jobs', match: ['jobs'] },
  // Schedule shares the jobs area: src/app/admin/schedule/page.tsx and
  // loading.tsx both render OperatorShell active="jobs" ("Schedule lives under
  // the Jobs nav item" per loading.tsx's own comment). Naldo approved this nav
  // item 2026-08-27.
  { label: 'Schedule', href: '/admin/schedule', match: ['jobs'] },
  // Fleet is its own area (Naldo, 2026-08-28: Jobs and Fleet lighting up
  // together was a bug, not an accepted cost).
  { label: 'Fleet', href: '/admin/fleet', match: ['fleet'] },
  { label: 'Invoices', href: '/admin/invoices', match: ['invoices'] },
  { label: 'Inventory', href: '/inventory', match: ['inventory'] },
  { label: 'Insights', href: '/insights', match: ['insights'] },
  { label: 'Settings', href: '/settings', match: ['settings', 'training'] },
];

/**
 * The nav items for a view. Positive-match on 'office' (the seam-gate
 * convention from AGENTS.md Pitfalls: a negative gate would silently hand
 * every future view the office nav). Crew and Advertising return no items
 * until those builds define their own lists.
 */
export function navItemsForView(view: OperatorView): NavItem[] {
  return view === 'office' ? OFFICE_ITEMS : [];
}
