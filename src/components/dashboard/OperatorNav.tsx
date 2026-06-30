'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { OperatorArea } from '@/components/OperatorShell';

type NavItem = { label: string; href: string; match: OperatorArea[] };

// Top-level operator areas, in the order Naldo specified. "New quote" lives on
// the dashboard CTA + the Quotes page (so /quote/* highlights Quotes); Training
// lives under Settings (so /training/* highlights Settings) — neither is a
// top-level item.
const ITEMS: NavItem[] = [
  { label: 'Home', href: '/', match: ['home'] },
  { label: 'Inbox', href: '/inbox', match: ['inbox'] },
  { label: 'Customers', href: '/customers', match: ['customers'] },
  { label: 'Quotes', href: '/admin/quotes', match: ['quotes', 'new'] },
  { label: 'Inventory', href: '/inventory', match: ['inventory'] },
  { label: 'Insights', href: '/insights', match: ['insights'] },
  { label: 'Settings', href: '/settings', match: ['settings', 'training'] },
];

export function OperatorNav({ active }: { active: OperatorArea }) {
  const [open, setOpen] = useState(false);
  const isActive = (item: NavItem) => item.match.includes(active);

  const linkStyle = (item: NavItem) =>
    isActive(item)
      ? { background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }
      : { color: 'var(--op-text-2)' };

  return (
    <nav
      aria-label="Operator navigation"
      className="border-b"
      style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
    >
      <div className="max-w-6xl mx-auto px-4 flex items-center justify-between gap-3 h-12">
        <span
          className="text-xs font-semibold uppercase tracking-widest shrink-0"
          style={{ color: 'var(--brand-evergreen-3)' }}
        >
          Yule Love Lights
        </span>

        {/* Desktop: inline links */}
        <ul className="hidden md:flex items-center gap-1 text-sm">
          {ITEMS.map(item => (
            <li key={item.href}>
              <Link href={item.href} className="px-3 py-1.5 rounded-md transition-colors" style={linkStyle(item)}>
                {item.label}
              </Link>
            </li>
          ))}
        </ul>

        {/* Mobile: hamburger toggle */}
        <button
          type="button"
          className="md:hidden inline-flex items-center justify-center w-9 h-9 rounded-md"
          style={{ color: 'var(--op-text)' }}
          aria-label="Toggle navigation menu"
          aria-expanded={open}
          onClick={() => setOpen(o => !o)}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            {open ? <path d="M6 6l12 12M6 18L18 6" /> : <path d="M3 6h18M3 12h18M3 18h18" />}
          </svg>
        </button>
      </div>

      {/* Mobile: dropdown menu */}
      {open && (
        <ul
          className="md:hidden border-t"
          style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
        >
          {ITEMS.map(item => (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={() => setOpen(false)}
                className="block px-4 py-3 text-sm font-medium border-b"
                style={{
                  borderColor: 'var(--op-border)',
                  ...(isActive(item)
                    ? { background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }
                    : { color: 'var(--op-text-2)' }),
                }}
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
