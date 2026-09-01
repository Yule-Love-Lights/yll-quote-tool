// Who can see what, in plain English (Naldo, 2026-09-01, for Jason).
//
// This is a DECLARED table, and rolePermissions.test.ts proves it against the
// code: every page listed must exist, every API listed must carry the gate
// claimed for it, every advertising row must sit inside the advertising
// perimeter, and every office row must sit outside it. Add a route with the
// wrong gate, or rename a page, and the test fails. That is the whole point:
// a permissions page that drifts is worse than no permissions page, because
// people believe it.
//
// It describes the PERIMETER and the ROUTE GATES. It is not a claim about row
// level access inside the database.
//
// The four populations use THREE different sign-in mechanisms, which is the
// single most confusing thing here and the reason this page exists:
//   - admin and office are the same kind of account, separated by one flag
//   - advertising is its own account type, fenced to its own surface
//   - crew is NOT an account at all. Crew logins were retired and are now
//     BLOCKED at the perimeter; field crew arrive on a signed link instead.

export type RoleId = 'admin' | 'office' | 'advertising' | 'crew';

/** How the route behind a capability is guarded. Each value is verified. */
export type Gate =
  /** `requireAdmin` in the route: an operator account flagged admin. */
  | 'admin'
  /** `requireOperator`: any signed-in operator, admin included. */
  | 'operator'
  /** `getAdvertisingCaller`: an advertising account only. */
  | 'advertising'
  /** `resolveCrewCaller`: the signed link cookie, not a login. */
  | 'crew-link';

export type Capability = {
  /** What it is, in the words someone would use out loud. */
  label: string;
  /** Why it matters, or the catch. One sentence. */
  detail: string;
  /** A page this opens. Verified to exist under src/app. */
  page?: string;
  /** An API route. Verified to carry `gate`. */
  api?: string;
  gate?: Gate;
};

/**
 * A "cannot" claim that names a PAGE, so the test can check it rather than
 * take it on trust. The premerge admin lens found the `cannot` list had zero
 * coverage while `can` had plenty, and the one claim it checked by hand was
 * false: /admin/leads had no server-side gate at all, so office staff could
 * open it. Anything checkable belongs here rather than in the prose list.
 */
export type CannotClaim = {
  /** The sentence shown on the page. */
  label: string;
  /** A page this role must be refused, verified to redirect server-side. */
  deniedPage?: string;
};

export type RoleSpec = {
  id: RoleId;
  name: string;
  /** Who this actually is, in the business rather than in the code. */
  whoTheyAre: string;
  /** How they get in. The part people get wrong. */
  howTheySignIn: string;
  can: Capability[];
  /** Stated plainly, because "what they cannot do" is half the question. */
  cannot: (string | CannotClaim)[];
};

/** The sentence for a cannot entry, whichever shape it is. PURE. */
export function cannotLabel(entry: string | CannotClaim): string {
  return typeof entry === 'string' ? entry : entry.label;
}

/** Every cannot entry that names a page the role must be refused. PURE. */
export function deniedPages(role: RoleSpec): { label: string; page: string }[] {
  return role.cannot
    .filter((c): c is CannotClaim => typeof c !== 'string' && !!c.deniedPage)
    .map((c) => ({ label: c.label, page: c.deniedPage as string }));
}

export const ROLES: ReadonlyArray<RoleSpec> = [
  {
    id: 'office',
    name: 'Office',
    whoTheyAre: 'Everyone who works in the office: quoting, the inbox, scheduling, invoicing.',
    howTheySignIn: 'Email and password, the ordinary login. This is the default for a new staff account.',
    can: [
      {
        label: 'The dashboard',
        detail: 'The day at a glance: drafts, unsent quotes, money booked.',
        page: '/',
      },
      {
        label: 'Inbox',
        detail: 'Leads and customer replies waiting on an answer.',
        page: '/inbox',
      },
      {
        label: 'Office tasks',
        detail: 'The shared to-do list, including tasks raised from calls.',
        page: '/tasks',
      },
      {
        label: 'Quotes',
        detail: 'Build, price, send and approve quotes. This is the money surface.',
        page: '/admin/quotes',
      },
      {
        label: 'Jobs',
        detail: 'Everything booked, and what still needs scheduling.',
        page: '/admin/jobs',
      },
      {
        label: 'Schedule and the vans',
        detail: 'Who is on which job today, with the live fleet map beside it.',
        page: '/admin/schedule',
      },
      {
        label: 'Invoices',
        detail: 'What is owed and what has been collected.',
        page: '/admin/invoices',
      },
      {
        label: 'Inventory',
        detail: 'Stock on hand and what a job will consume.',
        page: '/inventory',
      },
      {
        label: 'Customers',
        detail: 'Every customer, their history, and their properties.',
        page: '/customers',
      },
      {
        label: 'Search',
        detail: 'The header box: any customer, quote, job or invoice.',
        api: '/api/search',
        gate: 'operator',
      },
      {
        label: 'Settings',
        detail: 'Pricing rules, templates and integrations.',
        page: '/settings',
      },
      {
        label: 'Insights',
        detail: 'How the season is going.',
        page: '/insights',
      },
      {
        label: 'Call recordings',
        detail:
          'The calls pipeline: sync status and counts. Open to all office staff today because it holds no transcript text or audio yet.',
        page: '/admin/calls',
      },
    ],
    cannot: [
      'Add, remove or change staff accounts.',
      {
        label: 'See the website-leads sync page, or retry a failed lead.',
        deniedPage: '/admin/leads',
      },
      'Issue or revoke a crew link.',
      'Enter a manual shift or a time exception for payroll.',
      'Run the advertising review, pay workers, or issue signs.',
      'Switch into another role with View as.',
    ],
  },
  {
    id: 'admin',
    name: 'Admin',
    whoTheyAre: 'Naldo and Jason. The owner seat.',
    howTheySignIn:
      'The same email and password as office. The only difference is one flag on the account, set through the admin API, never by the person themselves.',
    can: [
      {
        label: 'Everything the office can',
        detail: 'Admin is office plus the rows below, not a separate surface.',
      },
      {
        label: 'Staff accounts',
        detail: 'Create staff, change a role, remove access.',
        api: '/api/admin/users',
        gate: 'admin',
      },
      {
        label: 'Website leads',
        detail: 'The website-form sync, and retrying a lead that failed to reach the CRM.',
        page: '/admin/leads',
        api: '/api/admin/leads',
        gate: 'admin',
      },
      {
        label: 'Crew links',
        detail: 'Issue and revoke the signed links field crew use to open My Day.',
        api: '/api/admin/crew/[id]/link',
        gate: 'admin',
      },
      {
        label: 'Payroll corrections',
        detail: 'Manual shifts and time exceptions.',
        api: '/api/admin/shifts/manual',
        gate: 'admin',
      },
      {
        label: 'Advertising back office',
        detail: 'Review photos, pay workers, issue signs, run settlements.',
        api: '/api/admin/advertising/review',
        gate: 'admin',
      },
      {
        label: 'View as',
        detail:
          'Switch the nav into another role to see what they see. It changes the MENU only; it grants nothing, and every page still checks the real account.',
      },
    ],
    cannot: [
      'Open the crew My Day page as a crew member. That needs a signed link, which admins issue rather than hold.',
      'Reach the advertising worker screens as an advertising worker. Those check for an advertising account, which an admin is not.',
    ],
  },
  {
    id: 'advertising',
    name: 'Advertising',
    whoTheyAre: 'The people who put out yard signs and door hangers and get paid per accepted photo.',
    howTheySignIn:
      'Their own account type, separate from office. The perimeter fences them to the advertising screens: anything else sends them back to the login page.',
    can: [
      {
        label: 'Their campaign list',
        detail: 'What is available to work right now.',
        page: '/advertising',
      },
      {
        label: 'The camera',
        detail: 'Photograph a placement, with the location captured at the shutter.',
        page: '/advertising/capture',
      },
      {
        label: 'Their own pay',
        detail: 'What they have earned, what has been accepted, what has settled.',
        api: '/api/advertising/earnings',
        gate: 'advertising',
      },
      {
        label: 'Their own placements',
        detail: 'What they submitted, and resubmitting one that was sent back.',
        api: '/api/advertising/placements',
        gate: 'advertising',
      },
      {
        label: 'Their own profile and password',
        detail: 'Their details, nothing anyone else can see.',
        page: '/advertising/profile',
      },
    ],
    cannot: [
      'See a single customer, quote, job or invoice. The perimeter refuses it before the page runs.',
      'Use the header search.',
      'See any other worker’s photos, pay or placements.',
      'Decide what gets accepted or paid. That is the admin review screen.',
    ],
  },
  {
    id: 'crew',
    name: 'Crew',
    whoTheyAre: 'Field crew installing the work.',
    howTheySignIn:
      'They do not. Crew logins were RETIRED, and a crew account is now blocked at the perimeter outright. Field crew open My Day from a signed link the office sends: it lasts 15 minutes and works once.',
    can: [
      {
        label: 'My Day',
        detail: 'Their own jobs for today, read only. Nothing to edit and nothing to submit.',
        page: '/crew',
        api: '/api/crew/today',
        gate: 'crew-link',
      },
    ],
    cannot: [
      'Sign in with a password at all. There is no crew login form.',
      'See any other crew member’s day.',
      'See prices, quotes, invoices or customer contact details.',
      'Reach anything else in the app, even with a valid link.',
    ],
  },
];

export function roleById(id: RoleId): RoleSpec | undefined {
  return ROLES.find((r) => r.id === id);
}
