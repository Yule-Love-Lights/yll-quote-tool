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
