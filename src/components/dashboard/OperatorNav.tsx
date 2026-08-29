'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { OperatorArea } from '@/components/OperatorShell';
import { navItemsForView, type NavItem } from './operatorView';
import { useOperatorView } from './OperatorViewContext';
import { ViewAsControl } from './ViewAsControl';

// The item list itself lives in operatorView.ts (ops hub workstream A slice
// 2): it flows through navItemsForView(view) so the later Crew My Day and
// Advertising builds add role-filtered nav by extending that data, not by
// rewriting this component. Today every operator's view is 'office' and the
// list is unchanged.

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
  const { view } = useOperatorView();
  const items = navItemsForView(view);
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
  // The caller's own role, from the same session answer. Drives the
  // admin-only View-as control below; null (pre-fetch, signed out, retry
  // exhausted) renders no control, so the safe default is "not admin".
  const [role, setRole] = useState<'admin' | 'operator' | null>(null);
  useEffect(() => {
    let cancelled = false;

    const check = (attempt: number): void => {
      fetch('/api/auth/session')
        .then(res => {
          if (res.status === 401) return { signedIn: false }; // real answer, not a failure
          if (!res.ok) throw new Error(`/api/auth/session ${res.status}`);
          return res.json() as Promise<{ signedIn?: boolean; role?: string }>;
        })
        .then(body => {
          if (cancelled) return;
          const signedIn = body.signedIn === true;
          setSessionState(signedIn ? 'signedIn' : 'signedOut');
          setRole(signedIn ? (body.role === 'admin' ? 'admin' : 'operator') : null);
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
        {/* lg:px-1.5 xl:px-3 (premerge staff MED, advertising-role-hardening
            fix round): adding the Schedule item (11 top-level items now, 13
            <li>s total with the CTA + Sign out) measured a 45px page-level
            overflow at 1024px in headless Chromium —
            document.documentElement.scrollWidth 1069 vs clientWidth 1024, the
            exact #56/S22 class recurring.

            FIRST ATTEMPT (px-3 → lg:px-2, no whitespace-nowrap) measured 0
            overflow, but that reading was a FALSE PASS: the "+ New quote" CTA
            and Sign-out button (both multi-word) were silently WRAPPING onto
            a second line under the remaining squeeze — their boxes rendered
            52px tall vs the other 11 links' 32px, poking out above and below
            the h-12 bar — and the wrap shrank their apparent WIDTH enough to
            hide a REAL 16px shortfall from a plain scrollWidth check. Adding
            `whitespace-nowrap` to both (below) to force single-line, then
            re-measuring, is what surfaced the true 16px overflow at 1024
            (1120/1280 were genuinely fine both times).

            lg:px-1.5 (not px-2) on these 11 links — WITH whitespace-nowrap in
            place so nothing can hide behind a wrap again — closes it with
            room to spare: measured (headless Chromium, 3 widths, font-ready +
            stability-checked, zero wrapped elements confirmed at every width):
              1024px: 0 overflow, ~11.75px real margin
              1120px: 0 overflow, ~107.75px margin
              1280px: 0 overflow (xl:px-3 restores full padding — this is
                       the original pre-Schedule design's natural fit)
            */}
        <ul className="hidden lg:flex items-center gap-0.5 text-sm">
          {items.map(item => (
            <li key={item.href}>
              <Link href={item.href} className="lg:px-1.5 xl:px-3 py-1.5 rounded-md transition-colors inline-flex items-center" style={linkStyle(item)}>
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
                the gap fix above, so the 1024px fit isn't zero-margin.
                whitespace-nowrap (advertising-role-hardening fix round): this
                CTA's label has a space ("+ New quote") and, once squeezed
                enough, would silently wrap onto 2 lines rather than shrink in
                width — that's the false-pass trap the lg:px-1.5 comment above
                explains. Forcing single-line makes its true width count
                toward the overflow check instead of hiding behind a wrap. */}
            <Link
              href="/quote/new"
              className="whitespace-nowrap px-2.5 py-1.5 rounded-md transition-colors inline-flex items-center font-medium"
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
            {/* lg:px-2 xl:px-3 + whitespace-nowrap (advertising-role-hardening
                fix round): same reasoning as the CTA above — "Sign out" has a
                space and was one of the two elements silently wrapping onto 2
                lines in the first (wrong) measurement of the tab-link fix.
                whitespace-nowrap forces it single-line; the padding step
                mirrors the tab links and contributes to the ~11.75px real
                margin measured at 1024px (see the lg:px-1.5 comment above for
                the full before/after numbers at all 3 widths). */}
            <button
              type="button"
              onClick={signOut}
              className="whitespace-nowrap lg:px-2 xl:px-3 py-1.5 rounded-md transition-colors"
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

      {/* Admin-only View-as strip (ops hub workstream A slice 2). Its own
          block row UNDER the h-12 header row on purpose: the 1024px header
          fit has ~12px of margin (see the lg:px-1.5 comment above), so the
          control must add zero width there. A block row adds ~29px of height
          for admins only, at every viewport width, and no width for anyone.
          Renders nothing until the session check above resolves an admin.

          KNOWN RESIDUAL (staff lens on PR #1055, deferred): because this nav
          remounts on every page and the role arrives by fetch, the strip pops
          in after each navigation and shifts admin page content down ~29px,
          the vertical twin of the #347 Sign-out flash fixed above. Reserving
          the space here would show a permanent blank band to every non-admin
          operator, so it is deliberately NOT reserve-space fixed. The real
          fix is server-rendering the role into the shell; that belongs to
          the first real view build (Crew My Day), which needs server-side
          view plumbing anyway. Affects only the two admin accounts. */}
      <ViewAsControl role={role} />

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
          {items.map(item => (
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
