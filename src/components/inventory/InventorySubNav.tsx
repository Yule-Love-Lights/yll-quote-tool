// src/components/inventory/InventorySubNav.tsx
import Link from 'next/link';

// Sub-navigation for the Inventory area (#82). Mirrors SettingsSubNav. "Overview"
// is the at-a-glance landing (#91, /inventory); "Stock" is the on-hand table
// (Slice 1c, now /inventory/stock); "Bindings" + "Overrides" are the Slice 1b
// config screens; "Materials" is the design→materials view (Slice 2d); "Bistro"
// (#117) is the static Thunder/Home Depot/Amazon reorder reference for the
// permanent-bistro vertical.
const ITEMS = [
  { label: 'Overview', href: '/inventory', key: 'overview' as const },
  { label: 'Stock', href: '/inventory/stock', key: 'stock' as const },
  { label: 'Jobs', href: '/inventory/jobs', key: 'jobs' as const },
  { label: 'Orders', href: '/inventory/orders', key: 'orders' as const },
  { label: 'Bindings', href: '/inventory/bindings', key: 'bindings' as const },
  { label: 'Overrides', href: '/inventory/overrides', key: 'overrides' as const },
  { label: 'Materials', href: '/inventory/materials', key: 'materials' as const },
  { label: 'Bistro', href: '/inventory/bistro', key: 'bistro' as const },
];

export type InventoryTab =
  | 'overview'
  | 'stock'
  | 'jobs'
  | 'orders'
  | 'bindings'
  | 'overrides'
  | 'materials'
  | 'bistro';

export function InventorySubNav({ active }: { active: InventoryTab }) {
  return (
    <div className="flex gap-1 mb-5 border-b" style={{ borderColor: 'var(--op-border)' }}>
      {ITEMS.map((item) => {
        const on = item.key === active;
        return (
          <Link
            key={item.key}
            href={item.href}
            className="px-3 py-2 text-sm font-medium -mb-px border-b-2 transition-colors"
            style={
              on
                ? { borderColor: 'var(--brand-evergreen)', color: 'var(--op-text)' }
                : { borderColor: 'transparent', color: 'var(--op-text-dim)' }
            }
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
