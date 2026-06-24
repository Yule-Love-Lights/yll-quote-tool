import Link from 'next/link';

type NavItem = { label: string; href: string };

const ITEMS: NavItem[] = [
  { label: 'Home', href: '/' },
  { label: 'Quotes', href: '/admin/quotes' },
  { label: 'New quote', href: '/quote/new' },
  { label: 'Training', href: '/training' },
  { label: 'Settings', href: '/settings' },
];

export function OperatorNav({ active }: { active: 'home' | 'quotes' | 'new' | 'training' | 'settings' }) {
  const isActive = (href: string) =>
    (active === 'home' && href === '/') ||
    (active === 'quotes' && href === '/admin/quotes') ||
    (active === 'new' && href === '/quote/new') ||
    (active === 'training' && href === '/training') ||
    (active === 'settings' && href === '/settings');

  return (
    <nav
      aria-label="Operator navigation"
      className="border-b"
      style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
    >
      <div className="max-w-6xl mx-auto px-4 flex items-center gap-6 h-12">
        <span
          className="text-xs font-semibold uppercase tracking-widest"
          style={{ color: 'var(--brand-evergreen-3)' }}
        >
          Yule Love Lights
        </span>
        <ul className="flex items-center gap-1 text-sm">
          {ITEMS.map(item => (
            <li key={item.href}>
              <Link
                href={item.href}
                className="px-3 py-1.5 rounded-md transition-colors"
                style={
                  isActive(item.href)
                    ? { background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }
                    : { color: 'var(--op-text-2)' }
                }
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
