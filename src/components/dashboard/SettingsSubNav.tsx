import Link from 'next/link';

// Sub-navigation for the Settings area: Training lives under Settings now
// (per the nav restructure). Rendered at the top of /settings + /training.
const ITEMS = [
  { label: 'Settings', href: '/settings', key: 'settings' as const },
  { label: 'Training', href: '/training', key: 'training' as const },
  // Placeholder for now — the customer-portal config tab (stub page).
  { label: 'Customer Portal', href: '/settings/customer-portal', key: 'customer-portal' as const },
  // Operator accounts (admin-only; the page itself gates on the admin role).
  { label: 'Accounts', href: '/settings/accounts', key: 'accounts' as const },
  // Test-quote tools + saved-quotes dev actions (#93).
  { label: 'Quotes', href: '/settings/quotes', key: 'quotes' as const },
  // Per-account editor keyboard shortcuts (#98).
  { label: 'Hotkeys', href: '/settings/hotkeys', key: 'hotkeys' as const },
];

export function SettingsSubNav({
  active,
}: {
  active: 'settings' | 'training' | 'customer-portal' | 'accounts' | 'quotes' | 'hotkeys';
}) {
  return (
    <div className="flex gap-1 mb-5 border-b" style={{ borderColor: 'var(--op-border)' }}>
      {ITEMS.map(item => {
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
