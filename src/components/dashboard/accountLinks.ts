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
//   1. It must be a real route. For /admin/calls this menu is the only door in
//      the app, so a typo there is a page nobody can reach rather than a
//      broken-looking link. The others do have other doors (the design editor
//      links Settings; the site-forms page links the leads page), which is
//      exactly why the route-existence test checks every row rather than
//      trusting that someone would notice.
//   2. Adding a row grants no permission. Each page keeps whatever gate it
//      already has; this list only decides where the door is drawn. Where a
//      page is admin-only BEHIND the door, mark the row adminOnly too, so the
//      menu does not offer a plain operator something they cannot open.

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
  // the destination agree: /admin/calls says "Call recordings".
  { label: 'Call recordings', href: '/admin/calls' },
  // "Website leads", not "Leads" (premerge staff lens). Staff already say
  // "leads" all day about the Inbox, whose badge reads "N leads waiting in the
  // inbox"; this page is the website-form sync, and its own heading says
  // Website leads. A bare "Leads" row sends someone told to "check the leads"
  // to the wrong screen.
  //
  // Admin only: /api/admin/leads is requireAdmin, which answers a signed-in
  // non-admin with 403 "Admin access required". The page only redirects on
  // 401, so that 403 surfaces as a red error banner rather than anything
  // explaining itself. Either way it is a dead end for an operator, so the row
  // is not offered to them. Opening the page up is a permissions decision, not
  // a menu one.
  { label: 'Website leads', href: '/admin/leads', adminOnly: true },
];

/**
 * The rows this caller may actually open. PURE.
 *
 * `roleConfirmed` is required rather than defaulted, because defaulting it
 * true would make the permissive answer the silent one. It is false until
 * GET /api/auth/session has actually answered: OperatorNav seeds `role` from a
 * localStorage hint one tick after hydration so an admin's controls appear at
 * first paint, and on a shared office computer that hint can still say 'admin'
 * for the NEXT person (premerge admin lens). An admin-only row must therefore
 * wait for the confirmed answer, not the hint. Hiding it is cosmetic either
 * way: requireAdmin on the route is what actually refuses the data.
 */
export function accountLinksFor(
  role: 'admin' | 'operator' | null,
  roleConfirmed: boolean,
): AccountLink[] {
  const isAdmin = roleConfirmed && role === 'admin';
  return ACCOUNT_LINKS.filter((l) => !l.adminOnly || isAdmin);
}
