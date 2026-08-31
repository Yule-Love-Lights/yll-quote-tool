// The pages that live in the header account menu rather than the tab row.
//
// Naldo, 2026-08-31: "Settings, Insights, Call Recording, and Leads, and then
// we'll move from there." A flat list on purpose. He raised grouping the last
// two under an "Other information" submenu and decided against it for now, so
// this stays four plain rows until the list is long enough to earn a heading.
//
// ONE source, two renderers. The desktop menu (AccountMenu.tsx) and the mobile
// hamburger (OperatorNav.tsx) both map over this array. They used to carry
// separate copies -- a hardcoded pair in the menu and a local const in the nav
// -- which meant adding a row here was two edits and forgetting one made a
// page reachable on a phone and not on a desktop, or the reverse.
//
// Two rules for anything added here:
//   1. It must be a real route. These are the ONLY doors to these pages now,
//      so a typo is a page nobody can reach rather than a broken-looking link.
//   2. Adding a row grants no permission. Each page keeps whatever gate it
//      already has; this list only decides where the door is drawn. Where a
//      page is admin-only BEHIND the door, mark the row adminOnly too, or a
//      plain operator gets a row that bounces them to a login screen they are
//      already signed in past.

export type AccountLink = {
  label: string;
  href: string;
  /**
   * Hide from anyone who is not a confirmed admin. Set it when the PAGE is
   * admin-only, so the menu tells the truth about what the person can open.
   * Null role (pre-fetch, signed out) counts as not-admin, the same safe
   * default the View-as control uses.
   */
  adminOnly?: boolean;
};

export const ACCOUNT_LINKS: ReadonlyArray<AccountLink> = [
  { label: 'Settings', href: '/settings' },
  { label: 'Insights', href: '/insights' },
  // Labelled to match the heading each page actually shows, so the row and
  // the destination agree: /admin/calls says "Call recordings" and
  // /admin/leads says "Website leads".
  { label: 'Call recordings', href: '/admin/calls' },
  // /api/admin/leads is requireAdmin, and the page bounces to /login on the
  // 401 rather than explaining itself. Shown to admins only, so a plain
  // operator never gets a row that dead-ends at a sign-in screen they are
  // already signed in past. Opening the page up to all operators is a
  // permissions decision, not a menu one.
  { label: 'Leads', href: '/admin/leads', adminOnly: true },
];

/** The rows this caller may actually open. PURE. */
export function accountLinksFor(role: 'admin' | 'operator' | null): AccountLink[] {
  return ACCOUNT_LINKS.filter((l) => !l.adminOnly || role === 'admin');
}
