// Shared placeholder rows for the /admin/site-forms list (row 346, mirrors
// admin/invoices' InvoicesListSkeleton, row 332/#171b) — used by BOTH the
// route's loading.tsx (shown instantly on a route transition, before the
// page has mounted) and the page's own client-fetch `loading` state (shown
// while its GET /api/admin/site-forms call is in flight, including on every
// tab switch). Previously the page's pending state rendered these same pulse
// rows inline (row 332) with no route-level loading.tsx to match, so a route
// transition into this page fell through to the root dashboard skeleton and
// then morphed into these rows once the page mounted — sharing the component
// with loading.tsx makes it one continuous skeleton instead.
export function SiteFormsListSkeleton() {
  return (
    <div role="status" aria-busy="true" style={{ display: 'grid', gap: 12 }}>
      <div className="animate-pulse" style={{ height: 72, borderRadius: 12, background: '#e5e5e5' }} />
      <div className="animate-pulse" style={{ height: 72, borderRadius: 12, background: '#e5e5e5' }} />
      <div className="animate-pulse" style={{ height: 72, borderRadius: 12, background: '#e5e5e5' }} />
    </div>
  );
}
