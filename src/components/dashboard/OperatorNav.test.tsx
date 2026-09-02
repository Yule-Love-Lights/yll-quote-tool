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

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: () => {}, refresh: () => {} }) }));

import { OperatorNav } from './OperatorNav';

describe('OperatorNav — Sign-out slot on initial render (before the session check resolves)', () => {
  it('mounts the account control unconditionally, so its layout width is always reserved', () => {
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    // The slot holds the ACCOUNT MENU as of 2026-08-30 (Sign out moved inside
    // it). The property under test is unchanged: the element must be present
    // in the DOM tree, not conditionally absent — that's the difference from
    // the pre-fix version, which used `{signedIn && <li>...}` and only
    // mounted the element once a session was confirmed.
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('Account menu for');
  });

  it('does not render the account slot as hidden before the session check answers ("unknown" reads as visible, not signedOut)', () => {
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    // The <li> wrapping the control carries visibility:hidden ONLY once
    // sessionState === 'signedOut'. On the very first render (before the
    // effect has had any chance to run) sessionState is 'unknown', which
    // must NOT be styled hidden — that's the bias-toward-visible fix for the
    // LOW (never silently strand a signed-in staffer with no control).
    expect(html).not.toMatch(/visibility:\s*hidden[^>]*>\s*<div[^>]*>\s*<button[^>]*aria-haspopup/);
  });

  it('forgets the recently-opened list when signing out', () => {
    // The list lives in sessionStorage, which survives a sign-out on a tab
    // nobody closed, so on a shared office computer the next person would find
    // the last person's customers in the search box (premerge staff lens).
    // Asserted on the SOURCE because this pass runs no effects and clicks
    // nothing; the clearing itself is tested in recentHits.test.ts.
    const source = readFileSync(new URL('./OperatorNav.tsx', import.meta.url), 'utf8');
    expect(source).toContain('clearRecent()');
    // BEFORE the network call, so an aborted sign-out still leaves nothing.
    const signOutBody = source.slice(source.indexOf('const signOut = async'));
    expect(signOutBody.indexOf('clearRecent()')).toBeLessThan(
      signOutBody.indexOf("fetch('/api/auth/logout'"),
    );
  });

  it('carries the time clock in the mobile menu, so "every page" holds below 1024px too', () => {
    // SOURCE, not markup: the hamburger dropdown only renders once opened, so
    // a static pass sees exactly one clock however many are wired up. The
    // first version of this test asserted two in the markup and failed for
    // that reason, not because the mobile one was missing.
    const source = readFileSync(new URL('./OperatorNav.tsx', import.meta.url), 'utf8');
    expect((source.match(/<ClockCard variant="header" \/>/g) ?? []).length).toBe(2);
    // One of them inside the mobile dropdown, which is what makes the claim
    // true below 1024px.
    const mobileBlock = source.slice(source.indexOf('{open && ('));
    expect(mobileBlock).toContain('<ClockCard variant="header" />');
  });

  it('keeps Sign out reachable by moving it inside the account menu, not by deleting it', () => {
    // The dropdown is closed in a static render, so its contents are out of
    // the tree — which is exactly why this asserts against the SOURCE that
    // the item still exists. Without it, "Sign out is gone from the header"
    // and "Sign out was removed from the app" look identical here.
    const source = readFileSync(
      new URL('./AccountMenu.tsx', import.meta.url),
      'utf8',
    );
    expect(source).toContain('Sign out');
    expect(source).toContain('onSignOut()');
  });
});

describe('OperatorNav — Tasks nav item (Naldo, 2026-08-29)', () => {
  it('renders a Tasks link pointing at the real /tasks page', () => {
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    expect(html).toContain('href="/tasks"');
    expect(html).toContain('>Tasks<');
  });

  it("highlights on its own 'tasks' area, not alongside another tab", () => {
    const html = renderToStaticMarkup(<OperatorNav active="tasks" />);
    // The active tab is the one carrying the evergreen background. Exactly
    // one link may carry it: the Jobs/Fleet co-lighting bug was ruled a
    // defect, not an accepted cost (Naldo, 2026-08-28).
    // Scoped to ANCHORS on purpose: the account menu's initials badge is a
    // <span> carrying the same evergreen, and counting every occurrence would
    // turn this from "exactly one tab is active" into "the header happens to
    // use the brand colour three times", which is not a defect anyone cares
    // about.
    const active = (html.match(/<a[^>]*background:var\(--brand-evergreen\)[^>]*>/g) ?? []).length;
    // Two hits are expected: the active tab and the "+ New quote" CTA, which
    // is styled as a CTA rather than a tab.
    expect(active).toBe(2);
    expect(html).toMatch(/background:var\(--brand-evergreen\)[^>]*>Tasks</);
  });

  it('renders no badge before the count fetch answers, so the row cannot flash a wrong number', () => {
    // renderToStaticMarkup never runs effects, so this is the pre-fetch
    // paint: taskCounts is null and the pill must be absent entirely.
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    expect(html).not.toContain('open task');
  });
});

describe('OperatorNav — Schedule nav item', () => {
  it('renders a Schedule link after Jobs, pointing at /admin/schedule', () => {
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    const jobsIdx = html.indexOf('>Jobs<');
    const scheduleIdx = html.indexOf('>Schedule<');
    expect(jobsIdx).toBeGreaterThan(-1);
    expect(scheduleIdx).toBeGreaterThan(jobsIdx);
    expect(html).toContain('href="/admin/schedule"');
  });

  it('does NOT highlight Schedule when the Jobs area is active (Naldo, 2026-08-31)', () => {
    // Until 2026-08-31 Schedule declared match: ['jobs'] and its page rendered
    // OperatorShell active="jobs", so the two tabs lit up together. That is
    // the same co-highlighting ruled a bug for Jobs/Fleet on 2026-08-28.
    const html = renderToStaticMarkup(<OperatorNav active="jobs" />);
    const scheduleLink = html.match(/<a[^>]*href="\/admin\/schedule"[^>]*>/);
    expect(scheduleLink).not.toBeNull();
    expect(scheduleLink![0]).not.toContain('background:var(--brand-evergreen)');
  });

  it('highlights Schedule alone on its own area', () => {
    const html = renderToStaticMarkup(<OperatorNav active="schedule" />);
    const scheduleLink = html.match(/<a[^>]*href="\/admin\/schedule"[^>]*>/);
    expect(scheduleLink![0]).toContain('background:var(--brand-evergreen)');
    const jobsLink = html.match(/<a[^>]*href="\/admin\/jobs"[^>]*>/);
    expect(jobsLink![0]).not.toContain('background:var(--brand-evergreen)');
    // Exactly one tab plus the CTA, the same count the Tasks test asserts.
    const active = (html.match(/<a[^>]*background:var\(--brand-evergreen\)[^>]*>/g) ?? []).length;
    expect(active).toBe(2);
  });
});

describe('OperatorNav — the four tabs that left the bar (Naldo, 2026-08-31)', () => {
  it('renders no Customers, Fleet, Insights or Settings tab', () => {
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    expect(html).not.toContain('href="/customers"');
    expect(html).not.toContain('href="/admin/fleet"');
    expect(html).not.toContain('>Insights<');
    // /settings still appears in the mobile account block below, so this
    // checks the TAB is gone rather than every mention of the word.
    expect(html).not.toContain('>Settings<');
  });

  it('keeps the account pages reachable in the mobile account block', () => {
    // The desktop door is the account menu, whose dropdown is closed in a
    // static render. The mobile dropdown is closed too, so this asserts the
    // shared link list exists in the source rather than the markup: with the
    // tabs gone, these two are the only doors left and must not be dropped.
    const source = readFileSync(new URL('./OperatorNav.tsx', import.meta.url), 'utf8');
    // The SHARED, role-filtered list, not a local copy: a second copy is how
    // the two menus drift apart, and an unfiltered one would show a plain
    // operator the admin-only Leads row.
    expect(source).toContain("accountLinksFor(role, sessionState === 'signedIn').map");
    expect(source).toContain("from './accountLinks'");
    expect(source).not.toContain("{ label: 'Settings', href: '/settings' }");
  });
});

describe('OperatorNav — admin View-as control (ops hub workstream A slice 2)', () => {
  it('does not render the View-as control before the session check resolves (unknown is not admin)', () => {
    // The role arrives from GET /api/auth/session (or the localStorage hint)
    // in effects this static render never runs, so this pins the safe
    // default: a plain operator, a signed-out browser, and the pre-role
    // state all see no View-as control, only the plain Sign-out button. The
    // admin-positive branch (the View-as section inside the account menu) is
    // not statically reachable — the dropdown is closed, and the role arrives
    // in an effect this render never runs. It is covered by
    // AccountMenu.test.tsx plus the PR's browser leg, which drives the open
    // menu, the View-as rows and the 1024px fit with a real admin session.
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
    expect(html).toContain('href="/admin/advertising/settings"');
    expect(html).toContain('href="/admin/advertising/crew"');
    // Office items are gone in this view.
    expect(html).not.toContain('href="/inbox"');
    // Review lights alone (one area per page; the Jobs/Fleet co-lighting class).
    const review = html.match(/<a[^>]*href="\/admin\/advertising"[^>]*>/);
    expect(review![0]).toContain('background:var(--brand-evergreen)');
    const pay = html.match(/<a[^>]*href="\/admin\/advertising\/settings"[^>]*>/);
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
  // RE-MEASURED 2026-08-31, after Customers, Fleet, Insights and Settings left
  // the bar. The row is `max-w-6xl`, so its usable width tops out at 1152px
  // however wide the monitor is: a bigger screen buys the header nothing, and
  // that cap is why the 2026-08-30 plan of shortening labels at 1024 and
  // restoring them at 1280 could not work. Four fewer tabs bought the full
  // wordmark, the full "+ New quote" label, roomier tab padding and a wider
  // search box all at once. With BOTH badges injected at two digits (Inbox and
  // Tasks, the widest this row ever gets), headless Chromium, fonts-ready, and
  // zero wrapped elements confirmed at every width:
  //   1024px: 0 page overflow, 0 row overflow, 58px slack
  //   1120px: 0 page overflow, 0 row overflow, 154px slack
  //   1280px: 0 page overflow, 0 row overflow, 46px slack
  //   1600px: 0 page overflow, 0 row overflow, 46px slack (the 1152px cap)
  it('forces the top-level tab links to a single line at every breakpoint (lg:px-1.5 xl:px-2.5)', () => {
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    const linkMatch = html.match(/<a[^>]*href="\/admin\/jobs"[^>]*>/);
    expect(linkMatch).not.toBeNull();
    expect(linkMatch![0]).toContain('lg:px-1.5');
    expect(linkMatch![0]).toContain('xl:px-2.5');
    // The tab links carry whitespace-nowrap too: the CTA and the account
    // trigger were not the only elements that could wrap once a badge started
    // sitting beside a label.
    expect(linkMatch![0]).toContain('whitespace-nowrap');
  });

  it('keeps the row gap at zero, which is part of what buys the 12th item its space', () => {
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    expect(html).toContain('hidden lg:flex items-center gap-0 text-sm');
  });

  it('forces the "+ New quote" CTA and the account trigger to stay single-line (whitespace-nowrap) so neither can hide behind a silent wrap', () => {
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    const ctaMatch = html.match(/<a[^>]*href="\/quote\/new"[^>]*>/);
    expect(ctaMatch).not.toBeNull();
    expect(ctaMatch![0]).toContain('whitespace-nowrap');
    const accountMatch = html.match(/<button[^>]*aria-haspopup="menu"[^>]*>/);
    expect(accountMatch).not.toBeNull();
    expect(accountMatch![0]).toContain('whitespace-nowrap');
  });

  it('carries the full wordmark and the full CTA label, which four fewer tabs paid for', () => {
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    expect(html).toContain('+ New quote');
    expect(html).toContain('Yule Love Lights');
    // No responsive label swapping left: one treatment at every width, which
    // is only affordable because the row lost four tabs.
    expect(html).not.toContain('>YLL<');
  });

  it('renders the search box in both the desktop row and the mobile bar, at a narrow width in the tight band', () => {
    const html = renderToStaticMarkup(<OperatorNav active="home" />);
    expect(html).toContain('id="header-search-desktop"');
    expect(html).toContain('id="header-search-mobile"');
    // The desktop wrapper stays narrow at lg and widens at xl. If this ever
    // grows without the row being re-measured, the 1024px fit is a guess.
    expect(html).toContain('hidden lg:block lg:w-40 xl:w-56 shrink-0');
  });
});
