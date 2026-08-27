'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { OperatorArea } from '@/components/OperatorShell';

type NavItem = { label: string; href: string; match: OperatorArea[] };

// Top-level operator areas, in the order Naldo specified. "New quote" lives on
// the dashboard CTA + the Quotes page (so /quote/* highlights Quotes); Training
// lives under Settings (so /training/* highlights Settings) — neither is a
// top-level item.
const ITEMS: NavItem[] = [
  { label: 'Home', href: '/', match: ['home'] },
  { label: 'Inbox', href: '/inbox', match: ['inbox'] },
  // Leads deliberately has NO nav item (Jason, 2026-08-26): the /admin/leads
  // page and everything behind it stay live — reachable by URL and from any
  // in-app links — it just doesn't earn a top-level slot. Visiting it renders
  // no highlighted tab (its 'leads' OperatorArea matches nothing here), which
  // is expected. Re-adding is one line: { label: 'Leads', href: '/admin/leads', match: ['leads'] }.
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

// Ledger #347 fix round (staff-lens MED + LOW): the session state is one of
// three things, not two. "unknown" is the state before the first
// GET /api/auth/session answer lands (or after a transient failure — see the
// effect below), and it renders THE SAME as "signedIn": the Sign-out slot
// stays visible and reserves its layout space the whole time, so mounting
// this nav fresh on 56 separate page files never shifts every other nav link
// sideways once the fetch resolves. Only a POSITIVE "signedOut" answer hides
// it (via CSS visibility, which keeps the reserved space AND drops the
// button from hit-testing/tab order — no separate disabled handling needed).
type SessionState = 'unknown' | 'signedIn' | 'signedOut';

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

  // This nav is shared chrome rendered on every operator page, several of
  // which do not fetch the operator session themselves — so it has no
  // server-provided session state to start from. It used to render "Sign
  // out" unconditionally, which lied on a signed-out browser (nothing to
  // sign out of). It is confirmed via GET /api/auth/session, which reports
  // the true session state directly (never through the dormancy-aware
  // requireOperator()) so this stays honest even while the gate is
  // deliberately off.
  //
  // A 401 from /api/auth/session is a REAL, meaningful answer (the perimeter
  // itself says "no session") and is treated as signedOut, not as an error.
  // A genuine network/server hiccup is retried once and otherwise leaves the
  // state at 'unknown' — it must never flip a real session to signedOut just
  // because one fetch blipped, which would silently strand a signed-in
  // staffer with no way to sign out until their next page load.
  const [sessionState, setSessionState] = useState<SessionState>('unknown');
  useEffect(() => {
    let cancelled = false;

    const check = (attempt: number): void => {
      fetch('/api/auth/session')
        .then(res => {
          if (res.status === 401) return { signedIn: false }; // real answer, not a failure
          if (!res.ok) throw new Error(`/api/auth/session ${res.status}`);
          return res.json() as Promise<{ signedIn?: boolean }>;
        })
        .then(body => {
          if (!cancelled) setSessionState(body.signedIn === true ? 'signedIn' : 'signedOut');
        })
        .catch(() => {
          if (cancelled) return;
          if (attempt < 1) {
            check(attempt + 1); // one retry on a transient failure
          }
          // Retry exhausted: leave sessionState at 'unknown'. Per the bias
          // above, 'unknown' renders the same as 'signedIn' (visible) —
          // showing Sign out to someone with no session is harmless (the
          // logout call just no-ops and redirects to /login); hiding it from
          // someone who IS signed in is the outcome to avoid.
        });
    };
    check(0);

    return () => {
      cancelled = true;
    };
  }, []);

  // Only a CONFIRMED signedOut hides the control. 'unknown' stays visible.
  const hideSignOut = sessionState === 'signedOut';

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
        {/* gap-0.5, not gap-1 (premerge staff MED on this PR): with the "+ New
            quote" CTA added, the row overflowed 1024px by ~20px whenever the
            Inbox badge showed — measured in headless Chromium, the exact
            iPad-width horizontal-scroll class #56/S22 fixed. Ten gaps × 2px
            saved = exactly the overflow. */}
        <ul className="hidden lg:flex items-center gap-0.5 text-sm">
          {ITEMS.map(item => (
            <li key={item.href}>
              <Link href={item.href} className="px-3 py-1.5 rounded-md transition-colors inline-flex items-center" style={linkStyle(item)}>
                {item.label}
                {inboxBadge(item)}
              </Link>
            </li>
          ))}
          {/* "+ New quote" (Jason, 2026-08-26): the dashboard header's CTA,
              duplicated here for one-click access from every page. The
              homepage copy stays — this is an addition, not a move. Styled
              as the CTA it is, not a nav tab, so it never takes the
              active-tab highlight (that is Quotes' job for /quote/*). */}
          <li>
            {/* px-2.5 (not the tabs' px-3): 4px of extra headroom on top of
                the gap fix above, so the 1024px fit isn't zero-margin. */}
            <Link
              href="/quote/new"
              className="px-2.5 py-1.5 rounded-md transition-colors inline-flex items-center font-medium"
              style={{ background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
            >
              + New quote
            </Link>
          </li>
          {/* Always mounted (ledger #347 fix round) — reserves its layout
              width so every link to its left never jumps once the session
              check resolves. `visibility: hidden` (not a conditional
              unmount) keeps the space, drops it from hit-testing, AND
              removes it from the tab order — no separate disabled handling
              needed. */}
          <li style={{ visibility: hideSignOut ? 'hidden' : 'visible' }}>
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
          {/* "+ New quote" first in the mobile menu — same one-click-access
              ask as the desktop CTA above. */}
          <li>
            <Link
              href="/quote/new"
              onClick={() => setOpen(false)}
              className="flex items-center px-4 py-3 text-sm font-semibold border-b"
              style={{ borderColor: 'var(--op-border)', background: 'var(--brand-evergreen)', color: 'var(--brand-cream)' }}
            >
              + New quote
            </Link>
          </li>
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
          {/* Same always-mounted / visibility-hidden treatment as the
              desktop copy above — this dropdown only opens on a click, so it
              is not the layout-shift MED, but it stays tri-state-consistent
              with its sibling rather than reintroducing the two-state bug. */}
          <li style={{ visibility: hideSignOut ? 'hidden' : 'visible' }}>
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
