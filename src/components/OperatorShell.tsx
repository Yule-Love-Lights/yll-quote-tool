import { OperatorNav } from './dashboard/OperatorNav';
import { OperatorViewProvider } from './dashboard/OperatorViewContext';
import { viewForArea } from './dashboard/operatorView';
import { MarkStaffDevice } from './MarkStaffDevice';

export type OperatorArea =
  | 'home'
  | 'inbox'
  | 'insights'
  | 'quotes'
  | 'jobs'
  // Schedule owns its own area as of 2026-08-31 (Naldo). It used to render
  // active="jobs", which lit BOTH tabs at once; that is the same defect ruled
  // a bug for Jobs/Fleet on 2026-08-28.
  | 'schedule'
  // 'calls' matches no nav item, like 'leads' below: /admin/calls is reached
  // from the account menu, not a tab. It used to declare itself as 'settings',
  // which was simply untrue -- it is not the settings page -- and became
  // visible when Settings lost its tab and the claim stopped being harmless.
  | 'calls'
  // 'fleet' matches no nav item any more: the fleet view is the right column
  // of the Schedule page and /admin/fleet redirects there. The area stays so
  // /admin/fleet/clocks keeps a valid one, the leads precedent below.
  | 'fleet'
  | 'invoices'
  | 'leads'
  | 'customers'
  | 'inventory'
  | 'tasks'
  | 'new'
  | 'training'
  | 'settings'
  // 'time' matches no nav item on purpose (the leads precedent in
  // OperatorNav.tsx: /admin/time-tracking is admin-only, reached from the
  // Fleet page link, and the 1024px nav row has no room for another slot).
  | 'time'
  // The advertising-view areas (#1061 surfaces + the View-as nav wiring).
  // They match items only in the ADVERTISING view's nav list, so they light
  // nothing in the office view; one area per page so tabs highlight alone.
  | 'advertising'
  | 'advertising-pay'
  | 'advertising-people';

// Shared chrome for every internal operator page: the branded top nav (links to
// every area) on the cream operator surface. Wrap a page's content in this so
// all pages share one header + color scheme (#58 follow-up). The customer
// portal has its own dark layout and does NOT use this.
//
// Pages keep their own inner max-width container as children — this only owns
// the nav, the page background, and the vertical padding.
export function OperatorShell({
  active,
  inboxOpenLeads,
  inboxOverdue,
  children,
}: {
  active: OperatorArea;
  // Optional Inbox nav badge counts (PS-E2) — pass through from a page that
  // already fetched them (see src/app/page.tsx). Omitted pages render no badge.
  inboxOpenLeads?: number;
  inboxOverdue?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--op-bg)' }}>
      {/* Marks this browser a staff device (S22) so a staff preview of a
          customer's portal link isn't recorded/notified as a customer view. */}
      <MarkStaffDevice />
      {/* One view context per page (ops hub workstream A slice 2): the nav's
          View-as control writes it, the nav's item list reads it, and later
          builds can read it from page content too. Client state, seeded from
          the page's own area (viewForArea), which is how a switched view
          survives navigation: an advertising page starts in the advertising
          view server-side, everything else starts office. */}
      <OperatorViewProvider initialView={viewForArea(active)}>
        <OperatorNav active={active} inboxOpenLeads={inboxOpenLeads} inboxOverdue={inboxOverdue} />
        <div className="flex-1 py-8 px-4">{children}</div>
      </OperatorViewProvider>
    </div>
  );
}
