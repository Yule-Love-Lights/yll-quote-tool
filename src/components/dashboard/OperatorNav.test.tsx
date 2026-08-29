// Ledger #347 fix round (staff-lens MED + LOW): OperatorNav's session check
// runs in a useEffect, and this suite has no jsdom/testing-library — Vitest
// here runs the 'node' environment, and the repo's .test.tsx precedent
// (VaultRegistrationNotice.test.tsx, ReferredByPicker.test.tsx) is a single
// react-dom/server renderToStaticMarkup pass. That pass never runs effects,
// so it can only observe the PRE-fetch render — but that is exactly the
// state that was under-tested: it proves the Sign-out slot is unconditionally
// mounted (space reserved) and starts VISIBLE (the 'unknown' state renders
// the same as 'signedIn', never hidden), which is the MED's fix. The
// eventual flip to hidden once /api/auth/session resolves signedOut is not
// exercisable without a DOM environment this suite doesn't have — asserting
// it here would mean faking a hook re-render, which is exactly the "brittle
// invented test" the brief warned against. Left unverified by an automated
// test; covered instead by the reasoning in the review report.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));

import { OperatorNav } from './OperatorNav';

describe('OperatorNav — Sign-out slot on initial render (before the session check resolves)', () => {
  it('mounts the Sign-out control unconditionally, so its layout width is always reserved', () => {
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    // Both the desktop copy and (once the mobile menu opens) the dropdown
    // copy share this markup; only the desktop one renders closed-by-default,
    // so this exercises that one. It must be present in the DOM tree, not
    // conditionally absent — that's the difference from the pre-fix version,
    // which used `{signedIn && <li>...}` and only mounted the element once
    // a session was confirmed.
    expect(html).toContain('Sign out');
  });

  it('does not render the Sign-out slot as hidden before the session check answers ("unknown" reads as visible, not signedOut)', () => {
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    // The <li> wrapping the button carries visibility:hidden ONLY once
    // sessionState === 'signedOut'. On the very first render (before the
    // effect has had any chance to run) sessionState is 'unknown', which
    // must NOT be styled hidden — that's the bias-toward-visible fix for the
    // LOW (never silently strand a signed-in staffer with no control).
    expect(html).not.toMatch(/visibility:\s*hidden[^>]*>\s*<button[^>]*>\s*Sign out/);
  });
});

describe('OperatorNav — Schedule nav item (Naldo, 2026-08-27)', () => {
  it('renders a Schedule link between Jobs and Fleet, pointing at /admin/schedule', () => {
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    const jobsIdx = html.indexOf('>Jobs<');
    const scheduleIdx = html.indexOf('>Schedule<');
    const fleetIdx = html.indexOf('>Fleet<');
    expect(jobsIdx).toBeGreaterThan(-1);
    expect(scheduleIdx).toBeGreaterThan(-1);
    expect(fleetIdx).toBeGreaterThan(-1);
    expect(jobsIdx).toBeLessThan(scheduleIdx);
    expect(scheduleIdx).toBeLessThan(fleetIdx);
    expect(html).toContain('href="/admin/schedule"');
  });

  it("highlights under the Jobs area (match: ['jobs']) rather than a nonexistent 'schedule' OperatorArea", () => {
    // src/app/admin/schedule/page.tsx and loading.tsx both render
    // OperatorShell active="jobs" — this nav item must agree, or visiting
    // /admin/schedule would light up no tab at all.
    const html = renderToStaticMarkup(<OperatorNav active="jobs" />);
    // Both the Jobs and Schedule (and Fleet) links share the same
    // active-highlight style object, so all three should carry the
    // evergreen background when active="jobs".
    const scheduleLinkMatch = html.match(/<a[^>]*href="\/admin\/schedule"[^>]*>/);
    expect(scheduleLinkMatch).not.toBeNull();
    expect(scheduleLinkMatch![0]).toContain('background:var(--brand-evergreen)');
  });
});

describe('OperatorNav — admin View-as control (ops hub workstream A slice 2)', () => {
  it('does not render the View-as control before the session check resolves (unknown is not admin)', () => {
    // The role arrives from GET /api/auth/session in an effect this static
    // render never runs, so this pins the safe default: a plain operator, a
    // signed-out browser, and the pre-fetch state all see no View-as control.
    // The admin-positive branch is covered at component level in
    // ViewAsControl.test.tsx (same reason the Sign-out flip is not asserted
    // here: no DOM environment to resolve the effect in).
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    expect(html).not.toContain('View as');
  });

  it('keeps the View-as slot out of the h-12 header row entirely (its own block row, zero width added at 1024px)', () => {
    // The 1024px fit has ~12px of margin (see the lg:px-1.5 comment in
    // OperatorNav.tsx). The control therefore must never be a child of the
    // header row ul. Rendered markup for a non-admin contains no trace of it,
    // which this and the test above pin together.
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    expect(html).not.toContain('aria-label="View as"');
  });
});

describe('OperatorNav — advertising view (View-as wiring, 2026-08-29)', () => {
  it('renders the advertising nav items, with Review highlighted on its own page, when the provider seeds the advertising view', async () => {
    const { OperatorViewProvider } = await import('./OperatorViewContext');
    const html = renderToStaticMarkup(
      <OperatorViewProvider initialView="advertising">
        <OperatorNav active="advertising" />
      </OperatorViewProvider>
    );
    expect(html).toContain('href="/admin/advertising"');
    expect(html).toContain('href="/admin/advertising/pay"');
    expect(html).toContain('href="/admin/advertising/crew"');
    // Office items are gone in this view.
    expect(html).not.toContain('href="/inbox"');
    // Review lights alone (one area per page; the Jobs/Fleet co-lighting class).
    const review = html.match(/<a[^>]*href="\/admin\/advertising"[^>]*>/);
    expect(review![0]).toContain('background:var(--brand-evergreen)');
    const pay = html.match(/<a[^>]*href="\/admin\/advertising\/pay"[^>]*>/);
    expect(pay![0]).not.toContain('background:var(--brand-evergreen)');
  });
});

describe('OperatorNav — 1024px overflow fix (premerge staff MED, advertising-role-hardening fix round)', () => {
  // Adding the 11th top-level item (Schedule) measured a real 45px page-level
  // horizontal overflow at 1024px in headless Chromium (the #56/S22 class),
  // masked on the FIRST fix attempt by two multi-word labels ("+ New quote",
  // "Sign out") silently wrapping onto a second line instead of shrinking —
  // which a plain scrollWidth check can't see. This suite has no jsdom/layout
  // environment (see the file header), so it cannot re-run that browser
  // measurement — that lives in the PR's manual Playwright verification. What
  // IS testable here is that the fix's load-bearing pieces are actually
  // present in the markup, so a future "cleanup" can't silently remove them
  // and reopen either failure mode (the overflow, or the invisible wrap).
  it('forces the 11 top-level tab links to a single line at every breakpoint (lg:px-1.5 xl:px-3)', () => {
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    const linkMatch = html.match(/<a[^>]*href="\/admin\/jobs"[^>]*>/);
    expect(linkMatch).not.toBeNull();
    expect(linkMatch![0]).toContain('lg:px-1.5');
    expect(linkMatch![0]).toContain('xl:px-3');
  });

  it('forces the "+ New quote" CTA and "Sign out" to stay single-line (whitespace-nowrap) so neither can hide behind a silent wrap', () => {
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    const ctaMatch = html.match(/<a[^>]*href="\/quote\/new"[^>]*>/);
    expect(ctaMatch).not.toBeNull();
    expect(ctaMatch![0]).toContain('whitespace-nowrap');
    const signOutMatch = html.match(/<button[^>]*>\s*Sign out/);
    expect(signOutMatch).not.toBeNull();
    // The className attribute sits before the closing '>' of the opening tag.
    const signOutOpenTag = html.slice(0, html.indexOf('Sign out')).split('<button').pop();
    expect(signOutOpenTag).toContain('whitespace-nowrap');
  });
});
