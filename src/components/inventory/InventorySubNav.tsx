// src/components/inventory/InventorySubNav.tsx
import Link from 'next/link';

// Sub-navigation for the Inventory area (#82). Mirrors SettingsSubNav. "Stock" is
// the existing /inventory stub (on-hand, later slice); "Bindings" + "Overrides"
// are the Slice 1b config screens. The Overrides item is added in 1b-iii.
const ITEMS = [
  { label: 'Stock', href: '/inventory', key: 'stock' as const },
  { label: 'Bindings', href: '/inventory/bindings', key: 'bindings' as const },
  { label: 'Overrides', href: '/inventory/overrides', key: 'overrides' as const },
];

export type InventoryTab = 'stock' | 'bindings' | 'overrides';

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
