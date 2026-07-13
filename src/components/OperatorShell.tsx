import { OperatorNav } from './dashboard/OperatorNav';
import { MarkStaffDevice } from './MarkStaffDevice';

export type OperatorArea =
  | 'home'
  | 'inbox'
  | 'insights'
  | 'quotes'
  | 'jobs'
  | 'invoices'
  | 'leads'
  | 'customers'
  | 'inventory'
  | 'new'
  | 'training'
  | 'settings';

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
      <OperatorNav active={active} inboxOpenLeads={inboxOpenLeads} inboxOverdue={inboxOverdue} />
      <div className="flex-1 py-8 px-4">{children}</div>
    </div>
  );
}
