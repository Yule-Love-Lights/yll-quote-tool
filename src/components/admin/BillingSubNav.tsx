// src/components/admin/BillingSubNav.tsx
import Link from 'next/link';

// Sub-navigation for the operator BILLING pipeline (ledger #83): a customer's
// quote flows Quote → Job → Invoice. Mirrors InventorySubNav. /admin/quotes is
// the existing list; /admin/jobs + /admin/invoices are the #83 surfaces. (The
// /inventory/jobs Kanban is the separate OPS view of the same job rows.)
const ITEMS = [
  { label: 'Quotes', href: '/admin/quotes', key: 'quotes' as const },
  { label: 'Jobs', href: '/admin/jobs', key: 'jobs' as const },
  { label: 'Invoices', href: '/admin/invoices', key: 'invoices' as const },
];

export type BillingTab = 'quotes' | 'jobs' | 'invoices';

export function BillingSubNav({ active }: { active: BillingTab }) {
  return (
    <div className="flex gap-1 mb-5 border-b border-gray-200">
      {ITEMS.map((item) => {
        const on = item.key === active;
        return (
          <Link
            key={item.key}
            href={item.href}
            className={`px-3 py-2 text-sm font-medium -mb-px border-b-2 transition-colors ${
              on
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
