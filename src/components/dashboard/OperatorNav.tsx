'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
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
  { label: 'Leads', href: '/admin/leads', match: ['leads'] },
  { label: 'Customers', href: '/customers', match: ['customers'] },
  { label: 'Quotes', href: '/admin/quotes', match: ['quotes', 'new'] },
  { label: 'Jobs', href: '/admin/jobs', match: ['jobs'] },
  { label: 'Invoices', href: '/admin/invoices', match: ['invoices'] },
  { label: 'Inventory', href: '/inventory', match: ['inventory'] },
  { label: 'Insights', href: '/insights', match: ['insights'] },
  { label: 'Settings', href: '/settings', match: ['settings', 'training'] },
];

// Small numeric pill for the Inbox nav item — red once something's overdue
// (>4h, matching the /inbox escalation convention), otherwise a neutral tone
// so a merely-waiting lead doesn't read as urgent.
function NavBadge({ count, overdue }: { count: number; overdue: boolean }) {
  return (
    <span
      aria-label={`${count} lead${count === 1 ? '' : 's'} waiting in the inbox`}
      className="ml-1.5 inline-flex items-center justify-center min-w-[1.15rem] h-[1.15rem] px-1 rounded-full text-[10px] font-semibold leading-none"
      style={{ background: overdue ? 'var(--op-danger)' : 'var(--op-text-2)', color: 'var(--brand-cream)' }}
    >
      {count}
    </span>
  );
}

export function OperatorNav({
  active,
  inboxOpenLeads = 0,
  inboxOverdue = 0,
}: {
  active: OperatorArea;
  // Open-lead / overdue counts for the Inbox badge — server-computed from the
  // same buildInboxSummary(listOpenItems()) pairing /inbox itself uses.
  // Omitted (0) on pages that don't fetch inbox data, in which case no badge shows.
  inboxOpenLeads?: number;
  inboxOverdue?: number;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const isActive = (item: NavItem) => item.match.includes(active);

  const linkStyle = (item: NavItem) =>
    isActive(item)
      ? { background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }
      : { color: 'var(--op-text-2)' };

  // WT-60: logout (POST /api/auth/logout) worked but had no UI trigger. Best
  // effort — even if the request fails, still send the operator to /login.
  const signOut = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  };

  const inboxBadge = (item: NavItem) =>
    item.href === '/inbox' && inboxOpenLeads > 0 ? (
      <NavBadge count={inboxOpenLeads} overdue={inboxOverdue > 0} />
    ) : null;

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

        {/* Desktop / tablet-landscape: inline links. Shown at lg+ (1024px), NOT
            md (768px): the 9-item row needs ~832px, so at md it overflowed the
            viewport → horizontal page scroll on iPad portrait (#56, S22). 768–1023
            uses the hamburger below. */}
        <ul className="hidden lg:flex items-center gap-1 text-sm">
          {ITEMS.map(item => (
            <li key={item.href}>
              <Link href={item.href} className="px-3 py-1.5 rounded-md transition-colors inline-flex items-center" style={linkStyle(item)}>
                {item.label}
                {inboxBadge(item)}
              </Link>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={signOut}
              className="px-3 py-1.5 rounded-md transition-colors"
              style={{ color: 'var(--op-text-2)' }}
            >
              Sign out
            </button>
          </li>
        </ul>

        {/* Mobile + tablet-portrait: hamburger toggle (shown below lg / 1024px) */}
        <button
          type="button"
          className="lg:hidden inline-flex items-center justify-center w-9 h-9 rounded-md"
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

      {/* Mobile + tablet-portrait: dropdown menu (shown below lg / 1024px) */}
      {open && (
        <ul
          className="lg:hidden border-t"
          style={{ borderColor: 'var(--op-border)', background: 'var(--op-bg-raised)' }}
        >
          {ITEMS.map(item => (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={() => setOpen(false)}
                className="flex items-center px-4 py-3 text-sm font-medium border-b"
                style={{
                  borderColor: 'var(--op-border)',
                  ...(isActive(item)
                    ? { background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }
                    : { color: 'var(--op-text-2)' }),
                }}
              >
                {item.label}
                {inboxBadge(item)}
              </Link>
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void signOut();
              }}
              className="block w-full text-left px-4 py-3 text-sm font-medium border-b"
              style={{ borderColor: 'var(--op-border)', color: 'var(--op-text-2)' }}
            >
              Sign out
            </button>
          </li>
        </ul>
      )}
    </nav>
  );
}
