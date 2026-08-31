// The header account menu (Naldo, 2026-08-30). Node-env static render, the
// same idiom OperatorNav.test.tsx uses: the closed-by-default state is what a
// static pass can see, and it pins the pieces a refactor could silently drop.
// The open-state behaviour (Settings, View as, Sign out) is asserted against
// the source below and driven for real in the PR's browser leg.

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

import { AccountMenu } from './AccountMenu';

const SOURCE = readFileSync(new URL('./AccountMenu.tsx', import.meta.url), 'utf8');

describe('AccountMenu — closed initial render', () => {
  const html = renderToStaticMarkup(
    <AccountMenu
      identity={{ name: 'Naldo Vengeance', email: 'naldo@example.com', role: 'admin' }}
      onSignOut={() => {}}
    />,
  );

  it('renders a trigger with menu semantics', () => {
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
  });

  it('names the signed-in person, which is the whole point of the control', () => {
    expect(html).toContain('Naldo Vengeance');
    // The initials carry the identity at the widths where the name is hidden,
    // so a screen reader must still get the full name from the label.
    expect(html).toContain('aria-label="Account menu for Naldo Vengeance"');
    expect(html).toContain('>NV<');
  });

  it('keeps the dropdown out of the tree until opened, so it costs no layout when closed', () => {
    expect(html).not.toContain('role="menu"');
    expect(html).not.toContain('href="/settings"');
    expect(html).not.toContain('not built yet');
  });

  it('stays single-line in the header slot (the 1024px fit discipline)', () => {
    const trigger = html.match(/<button[^>]*aria-haspopup[^>]*>/);
    expect(trigger).not.toBeNull();
    expect(trigger![0]).toContain('whitespace-nowrap');
  });

  it('keeps the trigger to initials at every width, because the header row never gains room', () => {
    // The row is max-w-6xl, so its usable width tops out at 1152px on any
    // monitor. Printing the name in the bar costs 80px that is not there once
    // the search box is in the row, and it was MEASURED to overflow. The name
    // stays in the dropdown and in the aria-label.
    const trigger = html.match(/<button[^>]*aria-haspopup[^>]*>[\s\S]*?<\/button>/);
    expect(trigger).not.toBeNull();
    // The visible text of the trigger is the initials and the caret, nothing more.
    expect(trigger![0]).toContain('>NV<');
    expect(trigger![0]).not.toContain('Naldo Vengeance<');
  });
});

describe('AccountMenu — an account with no name', () => {
  const html = renderToStaticMarkup(
    <AccountMenu
      identity={{ name: null, email: 'ops@example.com', role: 'operator' }}
      onSignOut={() => {}}
    />,
  );

  it('falls back to the email rather than naming nobody', () => {
    expect(html).toContain('ops@example.com');
    expect(html).toContain('>OP<');
  });
});

describe('AccountMenu — Sign out is the only conditional item', () => {
  // Premerge admin lens, 2026-08-31. The first cut wrapped the whole control
  // in the visibility toggle the old Sign-out button carried, so a confirmed
  // signedOut session hid Settings and Insights too. They are the ONLY doors
  // to those pages now that the tabs are gone.
  it('renders the trigger even when there is no session to sign out of', () => {
    const html = renderToStaticMarkup(
      <AccountMenu
        identity={{ name: null, email: null, role: null }}
        onSignOut={() => {}}
        canSignOut={false}
      />,
    );
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('Account menu for Signed in');
  });

  it('gates only the Sign-out item on the session, never the links', () => {
    // The gate wraps the Sign-out button alone. If a future edit moves the
    // links inside that block, this fails.
    const between = SOURCE.slice(SOURCE.indexOf('{canSignOut && ('));
    expect(between).toContain('Sign out');
    expect(between).not.toContain('href="/settings"');
    expect(between).not.toContain('href="/insights"');
  });

  it('defaults canSignOut to true, so the pre-fetch state keeps the control', () => {
    expect(SOURCE).toContain('canSignOut = true');
  });
});

describe('AccountMenu — the items the dropdown must carry', () => {
  // The dropdown is closed in a static render, so these assert the source.
  // Without them, "the menu is closed" and "the item was deleted" look
  // identical to this suite.
  it('keeps Sign out, and wires it to the caller-supplied handler', () => {
    expect(SOURCE).toContain('Sign out');
    expect(SOURCE).toContain('onSignOut()');
  });

  it('links to Settings and Insights, the two pages that lost their tabs', () => {
    expect(SOURCE).toContain('href="/settings"');
    expect(SOURCE).toContain('href="/insights"');
  });

  it('shows the View-as switcher to admins only', () => {
    expect(SOURCE).toContain("const isAdmin = identity.role === 'admin'");
    expect(SOURCE).toContain('{isAdmin && (');
  });
});
