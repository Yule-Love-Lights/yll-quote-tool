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
  // Wired 2026-08-29 when the #1061 advertising surfaces landed. The view is
  // the ADMIN side (review/pay/people): /advertising (the worker home)
  // redirects any admin back to the dashboard by its own design.
  { id: 'advertising', label: 'Advertising', built: true },
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

// The admin advertising surfaces (#1061). Distinct match areas so each tab
// highlights alone: Jobs and Fleet lighting up together was ruled a bug
// (Naldo, 2026-08-28), not an accepted cost.
const ADVERTISING_ITEMS: NavItem[] = [
  { label: 'Review', href: '/admin/advertising', match: ['advertising'] },
  { label: 'Pay', href: '/admin/advertising/pay', match: ['advertising-pay'] },
  { label: 'People', href: '/admin/advertising/crew', match: ['advertising-people'] },
];

/**
 * The nav items for a view. The Record is the positive seam gate (the
 * AGENTS.md convention: a negative gate would silently hand every future
 * view the office nav) and exhaustive by type, so adding an OperatorView
 * without deciding its nav list is a compile error. Crew stays empty until
 * the Crew My Day build defines its list.
 */
const ITEMS_BY_VIEW: Record<OperatorView, NavItem[]> = {
  office: OFFICE_ITEMS,
  crew: [],
  advertising: ADVERTISING_ITEMS,
};

export function navItemsForView(view: OperatorView): NavItem[] {
  return ITEMS_BY_VIEW[view];
}

// Areas that belong to the advertising view. Positive list on purpose (the
// seam-gate convention): an area not named here is office.
const ADVERTISING_AREAS: ReadonlyArray<OperatorArea> = [
  'advertising',
  'advertising-pay',
  'advertising-people',
];

/**
 * The view a page's own area implies, used by OperatorShell to seed the
 * provider. This is what makes the switched view SURVIVE navigation without
 * any client persistence: landing on an advertising page renders the
 * advertising nav server-side, every other page renders office.
 */
export function viewForArea(area: OperatorArea): OperatorView {
  return ADVERTISING_AREAS.includes(area) ? 'advertising' : 'office';
}
