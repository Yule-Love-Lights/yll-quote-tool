import { OperatorNav } from './dashboard/OperatorNav';

export type OperatorArea =
  | 'home'
  | 'inbox'
  | 'insights'
  | 'quotes'
  | 'jobs'
  | 'invoices'
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
  children,
}: {
  active: OperatorArea;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--op-bg)' }}>
      <OperatorNav active={active} />
      <div className="flex-1 py-8 px-4">{children}</div>
    </div>
  );
}
