import Link from 'next/link';

// Sub-navigation for the Settings area: Training lives under Settings now
// (per the nav restructure). Rendered at the top of /settings + /training.
const ITEMS = [
  { label: 'Settings', href: '/settings', key: 'settings' as const },
  { label: 'Training', href: '/training', key: 'training' as const },
  // The customer-portal config tab — early-install-discount toggle + swatch editor.
  { label: 'Customer Portal', href: '/settings/customer-portal', key: 'customer-portal' as const },
  // Operator accounts (admin-only; the page itself gates on the admin role).
  { label: 'Accounts', href: '/settings/accounts', key: 'accounts' as const },
  // Text-ops bot roster — crew/staff/admin by Telegram id (admin-only; #168).
  { label: 'Bot team', href: '/settings/bot-team', key: 'bot-team' as const },
  // Test-quote tools + saved-quotes dev actions (#93).
  { label: 'Quotes', href: '/settings/quotes', key: 'quotes' as const },
  // Per-account editor keyboard shortcuts (#98).
  { label: 'Hotkeys', href: '/settings/hotkeys', key: 'hotkeys' as const },
  // HighLevel CRM setup helper — pipeline + stage IDs for the env vars.
  { label: 'HighLevel', href: '/settings/highlevel', key: 'highlevel' as const },
];

export function SettingsSubNav({
  active,
}: {
  active:
    | 'settings'
    | 'training'
    | 'customer-portal'
    | 'accounts'
    | 'bot-team'
    | 'quotes'
    | 'hotkeys'
    | 'highlevel';
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
